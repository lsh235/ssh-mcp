import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, mkdtempSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Target } from './config.js';
import { assert, Fault, quote, sleep } from './core.js';
import { GatewayChannel, loginValues } from './gateway.js';

const helper = readFileSync(new URL('./runner/files.py', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./runner/worker.sh', import.meta.url), 'utf8');
export interface PollResult {
  done: null | {exitCode: number; cwd: string};
  streams: Record<string, {base64: string; size: number; truncated: boolean}>;
}
export class SSHConnection {
  private localDir = mkdtempSync(join(tmpdir(), 'shell-mcp-'));
  private socket = join(this.localDir, 's');
  private master?: ChildProcessWithoutNullStreams;
  private shell?: ChildProcessWithoutNullStreams;
  private alive = false;
  private diagnostics = '';
  private closeJob?: Promise<void>;
  private gateway?:GatewayChannel;
  remoteDir = '';
  root = '';
  onLost: (reason: string) => void = () => {};
  constructor(private target: Target, private maximum: number) { chmodSync(this.localDir, 0o700); }
  private args(multiplex: boolean,terminal=false): string[] {
    return [
      ...(this.target.sshConfig ? ['-F', this.target.sshConfig] : []),
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'RemoteCommand=none',
      '-e', 'none', '-o', terminal?'RequestTTY=force':'RequestTTY=no', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-S', this.socket,
      ...(multiplex ? ['-o', 'ControlMaster=no', '-o', 'ProxyCommand=false', '-o', 'ProxyJump=none'] : ['-M', '-N', '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no']),
      this.target.sshAlias
    ];
  }
  private lost(reason: string) { if (this.alive) { this.alive = false; this.onLost(reason); } }
  async open(root: string) {
    // Fail before any connection/input if a configured secret cannot be resolved.
    const values=this.target.postLogin?loginValues(this.target.postLogin):[];
    this.master = spawn('ssh', this.args(false));
    this.master.on('error', () => this.lost('SSH_START_FAILED'));
    this.master.stderr.on('data', b => { this.diagnostics = (this.diagnostics + b.toString()).slice(-4096); });
    this.master.on('exit', () => this.lost('SSH_DISCONNECTED'));
    const started = performance.now();
    while (!existsSync(this.socket)) {
      if (this.master.exitCode !== null || performance.now() - started > 12000) {
        const code = /Host key verification|REMOTE HOST IDENTIFICATION/.test(this.diagnostics) ? 'HOST_KEY_UNTRUSTED' : /Permission denied|authentication/i.test(this.diagnostics) ? 'AUTH_REQUIRED' : 'SSH_CONNECT_FAILED';
        await this.close(); throw new Fault(code, 'SSH connection failed; check the service account configuration on the MCP host');
      }
      await sleep(25);
    }
    this.alive = true;
    try {
      if(this.target.postLogin){
        this.shell=spawn('ssh',this.args(true,true));
        this.gateway=new GatewayChannel(this.shell,reason=>this.lost(reason));
        await this.gateway.open(this.target.postLogin,values);
      }
      const ready = await this.helper<{dir: string; root: string}>({op: 'prepare', root});
      this.remoteDir = ready.dir; this.root = ready.root;
      if(this.gateway){await this.gateway.start(worker,this.remoteDir,this.root,this.maximum);return;}
      const remote = `exec setsid --wait bash --noprofile --norc -c ${quote(worker)} -- ${quote(this.remoteDir)} ${quote(this.root)} ${this.maximum}`;
      this.shell = spawn('ssh', [...this.args(true), remote]);
      const shell = this.shell;
      shell.on('exit', () => this.lost('SHELL_EXITED'));
      shell.on('error', () => this.lost('SHELL_START_FAILED'));
      shell.stdin.on('error', () => this.lost('SHELL_INPUT_CLOSED'));
      shell.stderr.on('data', () => {});
      await new Promise<void>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => finish(new Fault('SHELL_START_FAILED', 'Persistent shell did not become ready')), 15000);
        const finish = (error?: Error) => { clearTimeout(timer); shell.stdout.off('data', data); shell.off('exit', exit); error ? reject(error) : resolve(); };
        const data = (b: Buffer) => { text = (text + b.toString()).slice(-1024); if (text.includes('SHELL_MCP_READY\n')) finish(); };
        const exit = () => finish(new Fault('SHELL_START_FAILED', 'Remote Bash worker exited during startup'));
        shell.stdout.on('data', data); shell.once('exit', exit);
      });
      shell.stdout.resume();
    } catch (error) { await this.close(); throw error; }
  }
  async exec(command: string, input = '', maximum = 2097152, timeout = 15000): Promise<{stdout: string; stderr: string; code: number}> {
    assert(this.alive && existsSync(this.socket), 'SSH_DISCONNECTED', 'SSH connection is no longer available');
    if(this.gateway)return this.gateway.exec(command,input,maximum,timeout);
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.args(true), command]);
      const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0; let settled = false;
      const timer = setTimeout(() => end(new Fault('REMOTE_TIMEOUT', 'Remote helper exceeded its deadline')), timeout);
      const end = (error?: Error, code = 0) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) { child.kill(); reject(error); }
        else resolve({stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code});
      };
      for (const [stream, buffers] of [[child.stdout, out], [child.stderr, err]] as const) stream.on('data', (b: Buffer) => {
        bytes += b.length; if (bytes > maximum) end(new Fault('OUTPUT_LIMIT', 'Remote helper response exceeds limit')); else buffers.push(b);
      });
      child.on('error', () => end(new Fault('SSH_EXEC_FAILED', 'Could not start SSH helper')));
      child.on('close', code => end(undefined, code ?? 255));
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  async helper<T = Record<string, unknown>>(args: Record<string, unknown>): Promise<T> {
    const result = await this.exec(`python3 -c ${quote(helper)}`, JSON.stringify({dir: this.remoteDir || undefined, ...args}), 4194304);
    assert(result.code === 0, 'REMOTE_HELPER_FAILED', 'Remote helper failed; Python 3 and required SSH channels must be available');
    let data: {result: T; error?: {code: string; message: string}};
    try { data = JSON.parse(result.stdout); } catch { throw new Fault('INVALID_REMOTE_RESULT', 'Remote helper returned an invalid result'); }
    if (data.error) throw new Fault(data.error.code, data.error.message);
    return data.result;
  }
  async submit(commandId: string, command: string, inputMode:'closed'|'pipe'='closed') {
    await this.helper({op: 'write_command', commandId, content: Buffer.from(command).toString('base64'),inputMode});
    assert(this.alive && this.shell, 'SSH_DISCONNECTED', 'Persistent shell is unavailable');
    if(this.gateway)await this.gateway.submit(commandId);
    else this.shell.stdin.write(commandId + '\n');
  }
  poll(commandId: string, offsets: Record<string, number>) {
    return this.helper<PollResult>({op:'poll', commandId, maximum:this.maximum, offsets});
  }
  async terminate() { return this.helper({op:'kill'}); }
  get running() { return this.alive; }
  async close() {
    if(this.closeJob)return this.closeJob;
    this.closeJob=this.cleanup(); return this.closeJob;
  }
  private async cleanup() {
    this.alive = false;
    if (this.remoteDir && existsSync(this.socket)) {
      // Closing the channel alone does not prove remote process termination.
      this.alive = true;
      await this.terminate().catch(() => {});
      await this.helper({op:'cleanup'}).catch(() => {});
      this.alive = false;
    }
    this.gateway?.close();this.shell?.stdin.end(); this.shell?.kill(); this.master?.kill();
    rmSync(this.localDir, { recursive:true, force:true });
  }
}
