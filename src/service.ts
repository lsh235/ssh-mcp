import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import type { Config, Target } from './config.js';
import { assert, Fault, hash, quote, sleep, uid } from './core.js';
import { Store, type RecordValue } from './storage.js';
import { SSHConnection } from './ssh.js';
import { pageBounds } from './upstream/output-page.js';

interface Session extends RecordValue { targetId: string; workspaceId: string; root: string; generation: number; cwd: string; }
interface Command extends RecordValue {
  sessionId: string; exitCode: number | null; stdoutBytes: number; stderrBytes: number;
  startedAt: number; deadlineMs: number; truncated: boolean; outputComplete: boolean; cwd: string;
  inputMode?: 'closed'|'pipe'; inputSequence?: number; inputBytes?: number; stdinClosed?: boolean; inputUncertain?: boolean;
}
interface Runtime { ssh: SSHConnection; busy: boolean; commandId?: string; cancelling: boolean; touched: number; job?: Promise<void>; inputBusy?: boolean; }
export class ShellService {
  readonly store: Store;
  private runtimes = new Map<string, Runtime>();
  private timer: NodeJS.Timeout;
  private stopping = false;
  private jobs=new Set<Promise<void>>();
  constructor(readonly config: Config) {
    this.store = new Store(config.stateDir);
    mkdirSync(join(config.stateDir, 'outputs'), { recursive:true, mode:0o700 });
    this.timer = setInterval(() => { void this.sweep(); }, Math.min(config.limits.idleMs, 30000)); this.timer.unref();
  }
  private audit(event: string, owner: string, id: string, state: string) {
    appendFileSync(join(this.config.stateDir, 'audit.jsonl'), JSON.stringify({at:new Date().toISOString(), event, owner, id, state})+'\n', {mode:0o600});
  }
  private target(owner: string, targetId: string): Target {
    const t = this.config.targets[targetId]; assert(t?.principals.includes(owner), 'FORBIDDEN', 'Target is not permitted'); return t;
  }
  listTargets(owner: string) {
    return Object.entries(this.config.targets).filter(([, t]) => t.principals.includes(owner)).map(([targetId,t]) => ({targetId,description:t.description,workspaces:Object.keys(t.workspaces)}));
  }
  session(owner: string, id: string): Session {
    const s = this.store.get('session', id, owner) as Session; this.target(owner,s.targetId); return s;
  }
  private runtime(owner: string, id: string) {
    const s = this.session(owner,id), r = this.runtimes.get(id);
    assert(r && r.ssh.running && ['ready','busy'].includes(s.state), 'SESSION_UNAVAILABLE', 'Session is not live; open a new session with a new request key');
    r.touched = performance.now(); return {s,r};
  }
  listSessions(owner: string) { return this.store.list('session',owner).filter(s => this.config.targets[s.targetId as string]?.principals.includes(owner)); }
  async open(owner: string, targetId: string, workspaceId: string, key: string, scope='open', generation=1, previousSessionId?:string) {
    assert(!this.stopping,'SERVER_STOPPING','Server is stopping');
    const t = this.target(owner,targetId), root = t.workspaces[workspaceId]; assert(root,'INVALID_WORKSPACE','Unknown workspace');
    const digest = hash(JSON.stringify([targetId,workspaceId]));
    const prior = this.store.request(owner,scope,key,digest); if (prior) return this.session(owner,prior);
    assert(this.runtimes.size < this.config.limits.maxSessions,'RESOURCE_LIMIT','Maximum live sessions reached');
    for (const session of this.store.list('session')) {
      if (['ready','busy','opening'].includes(session.state) && this.config.targets[session.targetId as string]?.sshAlias === t.sshAlias && (session.root === root || session.targetId === targetId && session.workspaceId === workspaceId)) {
        throw new Fault('WORKSPACE_BUSY','Workspace already has a live owner; use a separate workspace for parallel work');
      }
    }
    const id = uid('s');
    const s: Session = {id,sessionId:id,owner,targetId,workspaceId,root,cwd:root,generation,previousSessionId,state:'opening',updatedAt:Date.now(),mode:'managed'};
    this.store.put('session',s); this.store.remember(owner,scope,key,digest,id);
    const ssh = new SSHConnection(t,this.config.limits.maxOutputBytes);
    const r: Runtime = {ssh,busy:false,cancelling:false,touched:performance.now()}; this.runtimes.set(id,r);
    ssh.onLost = reason => {
      const current = this.session(owner,id);
      if (!['closed','broken'].includes(current.state)) this.store.put('session',{...current,state:'broken',reason});
      if (r.commandId && !r.cancelling) {
        const command = this.command(owner,r.commandId);
        if (['accepted','running'].includes(command.state)) this.store.put('command',{...command,state:'unknown',exitCode:null,outputComplete:false,reason});
      }
      this.audit('connection_lost',owner,id,reason);
    };
    try {
      await ssh.open(root); s.root=ssh.root; s.cwd=ssh.root; s.state='ready';
      this.store.put('session',s); this.audit('session_open',owner,id,'ready'); return s;
    } catch (error) {
      this.store.put('session',{...s,state:'broken',reason:error instanceof Fault ? error.code : 'SSH_CONNECT_FAILED'});
      this.runtimes.delete(id); await ssh.close(); throw error;
    }
  }
  command(owner: string, id: string): Command {
    const c = this.store.get('command',id,owner) as Command; this.session(owner,c.sessionId); return c;
  }
  findCommand(owner: string, sessionId: string, key: string) {
    this.session(owner,sessionId);
    const id = this.store.request(owner,sessionId,key); assert(id,'NOT_FOUND','Request has not been accepted'); return this.command(owner,id);
  }
  async reopen(owner:string,id:string,key:string) {
    const previous=this.session(owner,id), scope=`reopen:${id}`;
    const prior=this.store.request(owner,scope,key,hash(JSON.stringify([previous.targetId,previous.workspaceId])));
    if(prior)return this.session(owner,prior);
    assert(['closed','broken'].includes(previous.state),'SESSION_ACTIVE','Close or cancel the active session first');
    await this.closeSession(owner,id);
    const next=await this.open(owner,previous.targetId,previous.workspaceId,key,scope,previous.generation+1,id);
    return next;
  }
  listCommands(owner:string,id:string,state:string|undefined,cursor=0,maximum=50) {
    this.session(owner,id);return this.store.commands(owner,id,state,cursor,maximum);
  }
  async waitCommand(owner:string,id:string,waitMs=1000) {
    let c=this.command(owner,id); const started=performance.now();
    while(['accepted','running','cancel_requested'].includes(c.state)&&performance.now()-started<waitMs){
      await sleep(Math.min(50,Math.max(0,waitMs-(performance.now()-started)))); c=this.command(owner,id);
    }
    return {command:c,terminal:!['accepted','running','cancel_requested'].includes(c.state),waitedMs:Math.round(performance.now()-started)};
  }
  async sendInput(owner:string,id:string,data:string,end:boolean,key:string) {
    const c=this.command(owner,id), scope=`input:${id}`, digest=hash(JSON.stringify([data,end]));
    const prior=this.store.request(owner,scope,key,digest);if(prior)return this.store.get('input',prior,owner);
    assert(!this.stopping,'SERVER_STOPPING','Server is stopping');
    assert(c.state!=='accepted','INPUT_NOT_READY','Wait until the command is running before sending input');
    assert(c.state==='running','COMMAND_FINISHED','Command is no longer accepting input');
    assert(c.inputMode==='pipe','STDIN_DISABLED','Start this command with inputMode=pipe');
    assert(!c.stdinClosed,'STDIN_CLOSED','EOF has already been sent');
    assert(!c.inputUncertain,'INPUT_UNCERTAIN','A previous input has uncertain delivery; do not repeat it');
    const {r}=this.runtime(owner,c.sessionId);
    assert(!r.inputBusy,'INPUT_BUSY','Another input is being delivered');
    assert(r.commandId===id&&!r.cancelling,'COMMAND_FINISHED','Command is not active');
    const bytes=Buffer.byteLength(data);
    assert(bytes<=16384,'INPUT_LIMIT','Input message exceeds 16 KiB');
    assert(bytes>0||end,'EMPTY_INPUT','Supply data or end=true');
    const sequence=(c.inputSequence??0)+1;
    assert(sequence<=this.config.limits.maxInputMessages&&(c.inputBytes??0)+bytes<=this.config.limits.maxInputBytes,'INPUT_LIMIT','Command input limit exceeded');
    r.inputBusy=true;
    const inputId=uid('i');let input:RecordValue={id:inputId,owner,commandId:id,state:'accepted',sequence,bytes,end,updatedAt:Date.now()};
    try{
      this.store.put('input',input);this.store.remember(owner,scope,key,digest,inputId);
      this.store.put('command',{...c,inputSequence:sequence,inputBytes:(c.inputBytes??0)+bytes});
      try{
        await r.ssh.helper({op:'input',commandId:id,sequence,inputId,content:Buffer.from(data).toString('base64'),end});
        input={...input,state:'published'};
        if(end)this.store.put('command',{...this.command(owner,id),stdinClosed:true});
      }catch(error){
        input={...input,state:'unknown',reason:error instanceof Fault?error.code:'INPUT_FAILED'};
        this.store.put('command',{...this.command(owner,id),inputUncertain:true});
      }
      this.store.put('input',input);this.audit('input',owner,inputId,input.state);return input;
    }finally{r.inputBusy=false;}
  }
  async run(owner: string, id: string, command: string, key: string, waitMs=1000, deadlineMs=120000,inputMode:'closed'|'pipe'='closed') {
    assert(!this.stopping,'SERVER_STOPPING','Server is stopping');
    // Keep v0.1 request hashes for the unchanged closed-input default.
    const s = this.session(owner,id), digest = hash(JSON.stringify(inputMode==='closed'?[command,deadlineMs]:[command,deadlineMs,inputMode]));
    const prior = this.store.request(owner,id,key,digest); if (prior) return this.command(owner,prior);
    const {r} = this.runtime(owner,id); assert(!r.busy,'SESSION_BUSY','A command or mutation is already running');
    assert(deadlineMs<=this.config.limits.maxCommandMs,'INVALID_DEADLINE','Deadline exceeds server policy');
    assert(this.store.list('command').length<10000,'RESOURCE_LIMIT','Command history limit reached; expire old history before submitting more');
    const commandId=uid('c');
    const c: Command = {id:commandId,commandId,owner,sessionId:id,state:'accepted',generation:s.generation,exitCode:null,stdoutBytes:0,stderrBytes:0,startedAt:Date.now(),deadlineMs,truncated:false,outputComplete:false,cwd:s.cwd,updatedAt:Date.now(),inputMode,inputSequence:0,inputBytes:0,stdinClosed:inputMode==='closed'};
    this.store.put('command',c); this.store.remember(owner,id,key,digest,c.id);
    for (const stream of ['stdout','stderr']) writeFileSync(this.outputPath(c.id,stream),'',{mode:0o600});
    r.busy=true; r.commandId=c.id; this.store.put('session',{...s,state:'busy'});
    this.audit('command_accepted',owner,c.id,'accepted');
    // Admission is durable. This job is owned by the service, never the HTTP request.
    const job=this.execute(owner,c.id,r,command).catch(() => {}); r.job=job;
    this.jobs.add(job); void job.finally(()=>this.jobs.delete(job));
    const until=performance.now()+Math.min(waitMs,10000);
    while (performance.now()<until && ['accepted','running'].includes(this.command(owner,c.id).state)) await sleep(25);
    return this.command(owner,c.id);
  }
  private async execute(owner: string, id: string, r: Runtime, text: string) {
    let c = this.command(owner,id);
    const started=performance.now();
    try {
      await r.ssh.submit(id,text,c.inputMode);
      c=this.command(owner,id);
      if(r.cancelling||c.state!=='accepted')return;
      if(!r.ssh.running){this.store.put('command',{...c,state:'unknown',reason:'SSH_DISCONNECTED'});return;}
      c.state='running';this.store.put('command',c);
      while (r.ssh.running && !r.cancelling && !this.stopping) {
        c = this.command(owner,id); if (!['running','accepted'].includes(c.state)) break;
        if (performance.now()-started>c.deadlineMs) { await this.cancel(owner,id,true); break; }
        const p = await r.ssh.poll(id,{stdout:c.stdoutBytes,stderr:c.stderrBytes});
        c=this.command(owner,id);
        if (r.cancelling || !['running','accepted'].includes(c.state)) break;
        for (const stream of ['stdout','stderr'] as const) {
          const data=p.streams[stream]; if (!data) continue;
          const b=Buffer.from(data.base64,'base64'); appendFileSync(this.outputPath(id,stream),b);
          c[`${stream}Bytes`]+=b.length;
          if (data.truncated) c.truncated=true;
        }
        const drained=['stdout','stderr'].every(stream => !p.streams[stream] || c[`${stream}Bytes` as 'stdoutBytes']>=Math.min(p.streams[stream].size,this.config.limits.maxOutputBytes));
        if (p.done && drained) {
          await r.ssh.helper({op:'discard_command',commandId:id}).catch(()=>{c.remoteCleanupPending=true;});
          // Input publication can finish while the final spool is being removed.
          const current=this.command(owner,id);
          if(r.cancelling||!['running','accepted'].includes(current.state))break;
          c={...current,stdoutBytes:c.stdoutBytes,stderrBytes:c.stderrBytes,truncated:c.truncated,remoteCleanupPending:c.remoteCleanupPending};
          c.state='completed'; c.exitCode=p.done.exitCode; c.cwd=p.done.cwd; c.outputComplete=!c.truncated; c.endedAt=Date.now(); c.elapsedMs=performance.now()-started;
          const s=this.session(owner,c.sessionId); this.store.put('session',{...s,state:'ready',cwd:c.cwd});
          this.store.put('command',c); this.audit('command_finished',owner,id,c.state); break;
        }
        this.store.put('command',c); await sleep(this.config.limits.pollMs);
      }
    } catch (error) {
      c=this.command(owner,id);
      if (['accepted','running'].includes(c.state)) {
        this.store.put('command',{...c,state:'unknown',exitCode:null,reason:error instanceof Fault?error.code:'EXECUTION_FAILED',outputComplete:false});
        const s=this.session(owner,c.sessionId); this.store.put('session',{...s,state:'broken',reason:'COMMAND_UNCERTAIN'});
        await r.ssh.close();
      }
    } finally {
      r.busy=false; r.commandId=undefined; r.touched=performance.now();
    }
  }
  private outputPath(id: string, stream: string) { return join(this.config.stateDir,'outputs',`${id}.${stream}`); }
  readOutput(owner: string, id: string, stream: 'stdout'|'stderr', cursor=0, maximum=32768) {
    const c=this.command(owner,id), path=this.outputPath(id,stream);
    assert(existsSync(path),'OUTPUT_EXPIRED','Output has expired or is unavailable');
    const length=c[`${stream}Bytes`]; assert(cursor<=length,'INVALID_CURSOR','Cursor exceeds collected output');
    const {startIdx,endIdx}=pageBounds(length,cursor,maximum);
    const fd=openSync(path,'r'); const data=Buffer.alloc(endIdx-startIdx);
    try {
      // Byte cursors and base64 preserve UTF-8 sequences that span page boundaries.
      readSync(fd,data,0,data.length,startIdx);
    } finally { closeSync(fd); }
    return {commandId:id,stream,cursor,nextCursor:cursor+data.length,content:data.toString('utf8'),base64:data.toString('base64'),encoding:'utf-8',truncated:c.truncated,outputComplete:c.outputComplete,state:c.state};
  }
  async cancel(owner: string, id: string, timedOut=false) {
    let c=this.command(owner,id); if (!['accepted','running','cancel_requested'].includes(c.state)) return c;
    const r=this.runtimes.get(c.sessionId); assert(r,'SESSION_UNAVAILABLE','Live worker is unavailable');
    r.cancelling=true; this.store.put('command',{...c,state:'cancel_requested'});
    let confirmed=false;
    try { const result=await r.ssh.helper<{terminationConfirmed:boolean}>({op:'kill'}); confirmed=result.terminationConfirmed; } catch { /* uncertainty is returned, never success */ }
    c=this.command(owner,id);
    const result=this.store.put('command',{...c,state:confirmed?(timedOut?'timed_out':'cancelled'):'unknown',exitCode:null,outputComplete:false,shellStatePreserved:false,endedAt:Date.now()});
    const s=this.session(owner,c.sessionId); this.store.put('session',{...s,state:confirmed?'closed':'broken',reason:timedOut?'DEADLINE_EXCEEDED':'CANCELLED'});
    await r.ssh.close(); this.runtimes.delete(c.sessionId); this.audit('command_cancel',owner,id,result.state); return result;
  }
  async closeSession(owner: string, id: string) {
    const s=this.session(owner,id), r=this.runtimes.get(id); assert(!r?.busy||s.state==='broken','SESSION_BUSY','Cancel the active command before closing');
    if(r?.busy)await r.job;
    if (r) { await r.ssh.close(); this.runtimes.delete(id); }
    return this.store.put('session',{...s,state:'closed'});
  }
  private async locked<T>(owner: string, id: string, mutate: boolean, fn: (ssh: SSHConnection,s: Session)=>Promise<T>) {
    const {r,s}=this.runtime(owner,id); if (mutate) { assert(!r.busy,'SESSION_BUSY','Command or mutation is running'); r.busy=true; }
    try { return await fn(r.ssh,s); } finally { if (mutate) r.busy=false; r.touched=performance.now(); }
  }
  listFiles(owner:string,id:string,path='.',offset=0) { return this.locked(owner,id,false,(ssh,s)=>ssh.helper({op:'list',root:s.root,path,offset,maximum:100})); }
  readFile(owner:string,id:string,path:string) { return this.locked(owner,id,false,(ssh,s)=>ssh.helper<{content:string;version:string}>({op:'read',root:s.root,path})); }
  searchFiles(owner:string,id:string,query:string,path='.',caseSensitive=true,cursor=0,maximum=50) {
    return this.locked(owner,id,false,(ssh,s)=>ssh.helper({op:'search',root:s.root,path,query,caseSensitive,cursor,maximum}));
  }
  async patch(owner:string,id:string,patch:string,versions:Record<string,string|null>,key:string) {
    this.session(owner,id); const scope=`patch:${id}`, digest=hash(JSON.stringify([patch,Object.entries(versions).sort()]));
    const prior=this.store.request(owner,scope,key,digest); if (prior) return this.store.get('patch',prior,owner);
    return this.locked(owner,id,true,async(ssh,s)=>{
      const patches=parsePatch(patch); assert(patches.length>0 && patches.length<=20,'INVALID_PATCH','Expected a unified diff for 1 to 20 files');
      const files: {path:string;expectedVersion:string|null;content:string|null}[]=[]; const seen=new Set<string>();
      for (const p of patches) {
        const oldName=p.oldFileName?.replace(/^a\//,''), newName=p.newFileName?.replace(/^b\//,'');
        const path=newName==='/dev/null'?oldName:newName;
        assert(path && !seen.has(path),'INVALID_PATCH','Invalid or duplicate patch path'); seen.add(path);
        assert(oldName==='/dev/null'||newName==='/dev/null'||oldName===newName,'INVALID_PATCH','Renames are not supported');
        assert(Object.hasOwn(versions,path),'VERSION_REQUIRED','Supply the expected hash for each file, or null for creation');
        const expected=versions[path]; let old='';
        if(oldName!=='/dev/null') {
          const file=await ssh.helper<{content:string;version:string}>({op:'read',root:s.root,path});
          assert(file.version===expected,'VERSION_CONFLICT','File changed since it was read'); old=file.content;
        } else assert(expected===null,'VERSION_CONFLICT','New files require a null expected version');
        const next=applyPatch(old,p); assert(next!==false,'PATCH_CONFLICT','Patch does not apply cleanly');
        files.push({path,expectedVersion:expected,content:newName==='/dev/null'?null:Buffer.from(next).toString('base64')});
      }
      const pid=uid('p'); this.store.put('patch',{id:pid,owner,state:'unknown',updatedAt:Date.now(),reason:'ADMITTED'}); this.store.remember(owner,scope,key,digest,pid);
      const result=await ssh.helper<{state:string;files:unknown[]}>({op:'apply',root:s.root,files});
      const row=this.store.put('patch',{id:pid,owner,updatedAt:Date.now(),...result}); this.audit('patch',owner,pid,row.state); return row;
    });
  }
  git(owner:string,id:string,mode:'status'|'diff',paths:string[]=[]) {
    return this.locked(owner,id,true,async(ssh,s)=>{
      for (const path of paths) assert(!path.startsWith('/')&&!path.split('/').includes('..')&&!path.includes('\0'),'INVALID_PATH','Git path must stay inside workspace');
      const command=`cd -- ${quote(s.root)} && git -c core.fsmonitor=false -c core.pager=cat ${mode==='status'?'status --porcelain=v1':'diff --no-ext-diff --no-textconv --no-color'} -- ${paths.length?paths.map(p=>quote(':(literal)'+p)).join(' '):'.'}`;
      const result=await ssh.exec(command,'',1048576); assert(result.code===0,'GIT_FAILED','Git query failed; workspace must be a repository'); return {output:result.stdout};
    });
  }
  private async sweep() {
    if(this.stopping)return;
    for(const [id,r]of this.runtimes) if(!r.busy&&performance.now()-r.touched>this.config.limits.idleMs){
      const s=this.store.list('session').find(s=>s.id===id); if(s)await this.closeSession(s.owner,id).catch(()=>{});
    }
    for(const c of this.store.list('command')) if(!['accepted','running','cancel_requested'].includes(c.state)&&Date.now()-c.updatedAt>this.config.limits.retentionMs){
      for(const stream of ['stdout','stderr'])rmSync(this.outputPath(c.id,stream),{force:true});
    }
  }
  async shutdown() {
    this.stopping=true; clearInterval(this.timer);
    for(const [id,r]of this.runtimes){
      if(r.commandId)await this.cancel(this.sessionOwner(id),r.commandId).catch(()=>{});
      else {await r.ssh.close(); const s=this.store.list('session').find(s=>s.id===id);if(s)this.store.put('session',{...s,state:'closed'});}
    }
    // Allow command finalizers to finish before closing SQLite.
    await Promise.allSettled([...this.jobs]); this.runtimes.clear(); this.store.close();
  }
  private sessionOwner(id:string){return this.store.list('session').find(s=>s.id===id)!.owner;}
}
