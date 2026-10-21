import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { parseConfig } from '../src/config.js';
import { sleep } from '../src/core.js';
export async function fixture(options:{gate?:string}={}) {
  const dir=mkdtempSync(join(tmpdir(),'shell-mcp-test-')); const root=join(dir,'project');mkdirSync(root);
  execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,'host')]);
  execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,'client')]);
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
  const hostKey=readFileSync(join(dir,'host.pub'),'utf8').trim().split(' ').slice(0,2).join(' ');
  writeFileSync(join(dir,'known_hosts'),`[127.0.0.1]:${port} ${hostKey}\n`);
  if(options.gate)writeFileSync(join(dir,'gate.py'),options.gate,{mode:0o700});
  writeFileSync(join(dir,'sshd_config'),[
    `Port ${port}`,'ListenAddress 127.0.0.1',`HostKey ${join(dir,'host')}`,`PidFile ${join(dir,'sshd.pid')}`,
    `AuthorizedKeysFile ${join(dir,'client.pub')}`,'StrictModes no','PasswordAuthentication no','KbdInteractiveAuthentication no',
    'UsePAM no',`AllowUsers ${userInfo().username}`,'PrintMotd no','PrintLastLog no','MaxSessions 10',
    'Subsystem sftp internal-sftp','LogLevel ERROR',
    ...(options.gate?[`ForceCommand /usr/bin/python3 -u ${join(dir,'gate.py')}`]:[])
  ].join('\n')+'\n');
  writeFileSync(join(dir,'ssh_config'),`Host fixture\n HostName 127.0.0.1\n User ${userInfo().username}\n Port ${port}\n IdentityFile ${join(dir,'client')}\n IdentitiesOnly yes\n UserKnownHostsFile ${join(dir,'known_hosts')}\n GlobalKnownHostsFile /dev/null\n`);
  const daemon=spawn('/usr/sbin/sshd',['-D','-e','-f',join(dir,'sshd_config')]);let diagnostics='';daemon.stderr.on('data',b=>diagnostics+=b);
  await sleep(200);if(daemon.exitCode!==null)throw new Error(`Isolated sshd failed: ${diagnostics}`);
  const config=parseConfig({port:0,stateDir:join(dir,'state'),auth:{mode:'token',tokenEnv:'SHELL_MCP_TEST_TOKEN'},limits:{pollMs:75},targets:{test:{sshAlias:'fixture',sshConfig:join(dir,'ssh_config'),principals:['owner'],workspaces:{project:root}}}});
  return {dir,root,config,daemon,close:async()=>{daemon.kill();await sleep(100);rmSync(dir,{recursive:true,force:true});}};
}
