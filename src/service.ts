import { appendFileSync, chmodSync, closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatch, parsePatch } from 'diff';
import type { Config, Target } from './config.js';
import { assert, Fault, hash, quote, sleep, uid } from './core.js';
import { AuditLog } from './audit.js';
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
interface DownloadTransfer { owner:string; viewId:string; sessionId:string; bytes:number; sha256:string; filename:string; nextOffset:number; touched:number; }
async function digestFile(path:string){
  const digest=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(path,{highWaterMark:1048576})){bytes+=chunk.length;digest.update(chunk);}
  return {bytes,sha256:digest.digest('hex')};
}
async function digestFilePrefix(path:string,length:number){
  const digest=createHash('sha256');let bytes=0;
  if(length>0)for await(const chunk of createReadStream(path,{highWaterMark:1048576,start:0,end:length-1})){bytes+=chunk.length;digest.update(chunk);}
  assert(bytes===length,'TRANSFER_SOURCE_CHANGED','Could not verify the staged upload prefix');
  return digest.digest('hex');
}
export class ShellService {
  readonly store: Store;
  private readonly auditLog: AuditLog;
  private runtimes = new Map<string, Runtime>();
  private timer: NodeJS.Timeout;
  private stopping = false;
  private jobs=new Set<Promise<void>>();
  private downloads=new Map<string,DownloadTransfer>();
  constructor(readonly config: Config) {
    mkdirSync(config.stateDir, { recursive:true, mode:0o700 }); chmodSync(config.stateDir,0o700);
    this.auditLog = new AuditLog(join(config.stateDir,'audit.jsonl'),{maxFileBytes:config.audit.maxFileBytes});
    try {
      this.store = new Store(config.stateDir);
      mkdirSync(join(config.stateDir, 'outputs'), { recursive:true, mode:0o700 });
      const transferDir=join(config.stateDir,'transfers');
      mkdirSync(transferDir,{recursive:true,mode:0o700});chmodSync(transferDir,0o700);
      for(const entry of readdirSync(transferDir,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.upload')){
        const path=join(transferDir,entry.name);if(lstatSync(path).isFile())rmSync(path);
      }
    } catch (error) {
      this.auditLog.close();
      throw error;
    }
    this.timer = setInterval(() => { void this.sweep(); }, Math.min(config.limits.idleMs, 30000)); this.timer.unref();
  }
  private audit(event: string, owner: string, id: string, state: string) {
    this.auditLog.append({event,owner,id,state});
  }
  private assertAuditHealthy() {
    assert(this.auditLog.healthy,'AUDIT_UNAVAILABLE','Audit log is unavailable; remote changes are disabled');
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
  createSessionView(owner:string,sessionIds:string[],label:string,key:string){
    const ids=[...new Set(sessionIds)];ids.forEach(id=>this.session(owner,id));
    const scope='session-view',digest=hash(JSON.stringify([ids,label]));
    let id=this.store.request(owner,scope,key,digest);
    if(!id){
      assert(this.store.list('view',owner).length<1000,'RESOURCE_LIMIT','Maximum saved session views reached');
      id=uid('v');this.store.put('view',{id,owner,state:'active',updatedAt:Date.now(),sessionIds:ids,label});
      this.store.remember(owner,scope,key,digest,id);
    }
    return {viewId:id,url:new URL('/sessions',this.config.publicUrl).href+'#'+id,sessionIds:ids,label};
  }
  sessionView(owner:string,id:string){
    const view=this.store.get('view',id,owner);
    const sessions=(view.sessionIds as string[]).map(sessionId=>{
      const s=this.session(owner,sessionId);
      return {sessionId:s.id,targetId:s.targetId,workspaceId:s.workspaceId,generation:s.generation,
        cwd:s.cwd,state:s.state,updatedAt:s.updatedAt,reason:s.reason};
    });
    return {viewId:id,label:view.label,maxTransferBytes:this.config.limits.maxTransferBytes,sessions};
  }
  private viewSession(owner:string,viewId:string,sessionId:string){
    const view=this.sessionView(owner,viewId);
    assert(view.sessions.some(s=>s.sessionId===sessionId),'NOT_FOUND','Session is not included in this view');
  }
  viewCommands(owner:string,viewId:string,sessionId:string){
    this.viewSession(owner,viewId,sessionId);
    return this.store.recentCommands(owner,sessionId).map(c=>({commandId:c.id,displayName:c.displayName,state:c.state,exitCode:c.exitCode,
      startedAt:c.startedAt,endedAt:c.endedAt,elapsedMs:c.elapsedMs,stdoutBytes:c.stdoutBytes,stderrBytes:c.stderrBytes,
      truncated:c.truncated,outputComplete:c.outputComplete,inputMode:c.inputMode,stdinClosed:c.stdinClosed,reason:c.reason}));
  }
  viewOutput(owner:string,viewId:string,commandId:string,stream:'stdout'|'stderr',cursor:number){
    const c=this.command(owner,commandId);this.viewSession(owner,viewId,c.sessionId);
    return this.readOutput(owner,commandId,stream,cursor);
  }
  validateViewFilePath(owner:string,viewId:string,sessionId:string,path:string){
    this.viewSession(owner,viewId,sessionId);
    assert(path.length>0&&path.length<=4096&&!/[\x00-\x1f\x7f]/.test(path),'INVALID_PATH','Remote path contains invalid characters');
  }
  async open(owner: string, targetId: string, workspaceId: string, key: string, scope='open', generation=1, previousSessionId?:string) {
    assert(!this.stopping,'SERVER_STOPPING','Server is stopping');
    const t = this.target(owner,targetId), root = t.workspaces[workspaceId]; assert(root,'INVALID_WORKSPACE','Unknown workspace');
    const digest = hash(JSON.stringify([targetId,workspaceId]));
    const prior = this.store.request(owner,scope,key,digest); if (prior) return this.session(owner,prior);
    this.assertAuditHealthy();
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
      try { this.audit('connection_lost',owner,id,reason); } catch { /* the failed audit chain already blocks new mutations */ }
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
    this.assertAuditHealthy();
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
      // Record the intent before sending any input to the remote process. Never persist its contents.
      this.audit('input_requested',owner,inputId,'delivery_requested');
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
  async run(owner: string, id: string, command: string, key: string, waitMs=1000, deadlineMs=120000,inputMode:'closed'|'pipe'='closed',displayName?:string) {
    assert(!this.stopping,'SERVER_STOPPING','Server is stopping');
    // Keep v0.1 request hashes for the unchanged closed-input default.
    const payload:unknown[]=inputMode==='closed'?[command,deadlineMs]:[command,deadlineMs,inputMode];
    if(displayName!==undefined)payload.push({displayName});
    const s = this.session(owner,id), digest = hash(JSON.stringify(payload));
    const prior = this.store.request(owner,id,key,digest); if (prior) return this.command(owner,prior);
    this.assertAuditHealthy();
    const {r} = this.runtime(owner,id); assert(!r.busy,'SESSION_BUSY','A command or mutation is already running');
    assert(deadlineMs<=this.config.limits.maxCommandMs,'INVALID_DEADLINE','Deadline exceeds server policy');
    assert(this.store.list('command').length<10000,'RESOURCE_LIMIT','Command history limit reached; expire old history before submitting more');
    const commandId=uid('c');
    const c: Command = {id:commandId,commandId,owner,sessionId:id,state:'accepted',generation:s.generation,exitCode:null,stdoutBytes:0,stderrBytes:0,startedAt:Date.now(),deadlineMs,truncated:false,outputComplete:false,cwd:s.cwd,updatedAt:Date.now(),inputMode,inputSequence:0,inputBytes:0,stdinClosed:inputMode==='closed',...(displayName!==undefined?{displayName}:{})};
    this.store.put('command',c); this.store.remember(owner,id,key,digest,c.id);
    for (const stream of ['stdout','stderr']) writeFileSync(this.outputPath(c.id,stream),'',{mode:0o600});
    r.busy=true; r.commandId=c.id; this.store.put('session',{...s,state:'busy'});
    try {
      this.audit('command_accepted',owner,c.id,'accepted');
    } catch {
      this.store.put('command',{...c,state:'unknown',reason:'AUDIT_WRITE_FAILED',exitCode:null,outputComplete:false,endedAt:Date.now()});
      this.store.put('session',{...s,state:'broken',reason:'AUDIT_WRITE_FAILED'});
      r.busy=false; r.commandId=undefined;
      this.runtimes.delete(id);
      await r.ssh.close().catch(()=>{});
      throw new Fault('AUDIT_UNAVAILABLE','Command was not sent because its admission could not be recorded');
    }
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
    this.assertAuditHealthy();
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
      this.audit('patch_started',owner,pid,'applying');
      const result=await ssh.helper<{state:string;files:unknown[]}>({op:'apply',root:s.root,files});
      const row=this.store.put('patch',{id:pid,owner,updatedAt:Date.now(),...result});
      try { this.audit('patch',owner,pid,row.state); }
      catch { return {...row,auditWarning:'AUDIT_WRITE_FAILED'}; }
      return row;
    });
  }
  git(owner:string,id:string,mode:'status'|'diff',paths:string[]=[]) {
    return this.locked(owner,id,true,async(ssh,s)=>{
      for (const path of paths) assert(!path.startsWith('/')&&!path.split('/').includes('..')&&!path.includes('\0'),'INVALID_PATH','Git path must stay inside workspace');
      const command=`cd -- ${quote(s.root)} && git -c core.fsmonitor=false -c core.pager=cat ${mode==='status'?'status --porcelain=v1':'diff --no-ext-diff --no-textconv --no-color'} -- ${paths.length?paths.map(p=>quote(':(literal)'+p)).join(' '):'.'}`;
      const result=await ssh.exec(command,'',1048576); assert(result.code===0,'GIT_FAILED','Git query failed; workspace must be a repository'); return {output:result.stdout};
    });
  }
  private uploadReceipt(owner:string,id:string){
    const row=this.store.get('transfer',id,owner);
    if(row.state==='completed')return {transferId:id,state:row.state,bytes:row.bytes,sha256:row.sha256};
    if(row.state==='started')throw new Fault('TRANSFER_IN_PROGRESS','An upload with this request ID is still being resolved');
    if(row.state==='unknown')throw new Fault('TRANSFER_UNKNOWN','Upload outcome is uncertain; inspect the remote workspace before retrying');
    throw new Fault('TRANSFER_FAILED','Upload did not complete; use a new request ID for another attempt');
  }
  async uploadViewFile(owner:string,viewId:string,sessionId:string,path:string,localPath:string,requestId:string,signal?:AbortSignal){
    this.validateViewFilePath(owner,viewId,sessionId,path);
    assert(requestId.length>0&&requestId.length<=128,'INVALID_ARGUMENT','Invalid transfer request ID');
    const local=await digestFile(localPath);
    assert(local.bytes<=this.config.limits.maxTransferBytes,'FILE_TOO_LARGE','Upload exceeds the configured transfer limit');
    const digest=hash(JSON.stringify([path,local.bytes,local.sha256])),scope=`view-upload:${viewId}:${sessionId}`;
    const prior=this.store.request(owner,scope,requestId,digest);
    if(prior){
      const previous=this.store.get('transfer',prior,owner);
      if(previous.state==='completed')return this.uploadReceipt(owner,prior);
      if(previous.state==='started')throw new Fault('TRANSFER_IN_PROGRESS','An upload with this request ID is still being resolved');
      if(previous.state!=='unknown'||previous.reason==='SERVER_RESTART')return this.uploadReceipt(owner,prior);
    }
    this.assertAuditHealthy();
    return this.locked(owner,sessionId,true,async(ssh,s)=>{
      const repeated=this.store.request(owner,scope,requestId,digest);
      let id:string,row:RecordValue;
      if(repeated){
        id=repeated;row=this.store.get('transfer',id,owner);
        if(row.state==='completed')return this.uploadReceipt(owner,id);
        if(row.state==='started')throw new Fault('TRANSFER_IN_PROGRESS','An upload with this request ID is still being resolved');
        assert(row.state==='unknown'&&row.reason!=='SERVER_RESTART','TRANSFER_UNKNOWN','Upload cannot resume because its SSH session is no longer live');
        row=this.store.put('transfer',{...row,state:'started',reason:'RESUMING'});
      }else{
        id=uid('u');row={id,owner,state:'started',updatedAt:Date.now(),sessionId,viewId,
          direction:'upload',bytes:local.bytes,sha256:local.sha256};
        this.audit('file_upload_requested',owner,id,'accepted');
        this.store.put('transfer',row);this.store.remember(owner,scope,requestId,digest,id);
      }
      let beginAttempted=false,stage='begin';
      const remoteTimeout=this.config.limits.transferTimeoutMs;
      try{
        if(signal?.aborted)throw new Fault('TRANSFER_CANCELLED','Upload was cancelled before remote transfer began');
        beginAttempted=true;
        let begin=await ssh.helper<{state:string;bytes:number;nextSequence?:number;prefixSha256?:string}>({op:'upload_begin',root:s.root,path,transferId:id,bytes:local.bytes,
          maxBytes:this.config.limits.maxTransferBytes,sha256:local.sha256},remoteTimeout);
        if(begin.state==='completed'||begin.state==='publishing'){
          const finished=await ssh.helper<{state:string;bytes:number;sha256:string}>({op:'upload_finish',transferId:id},remoteTimeout);
          assert(finished.state==='completed'&&finished.bytes===local.bytes&&finished.sha256===local.sha256,
            'TRANSFER_UNKNOWN','Remote upload did not confirm its final checksum');
          row=this.store.put('transfer',{...row,state:'completed'});
          try{this.audit('file_upload',owner,id,'completed');}catch{return {transferId:id,state:'completed',bytes:local.bytes,sha256:local.sha256,auditWarning:'AUDIT_WRITE_FAILED'};}
          return {transferId:id,state:'completed',bytes:local.bytes,sha256:local.sha256};
        }
        assert(begin.state==='uploading','TRANSFER_UNKNOWN','Remote upload is not resumable');
        let offset=begin.bytes,sequence=begin.nextSequence??0;
        if(!Number.isSafeInteger(offset)||offset<0||offset>local.bytes||
           (offset!==local.bytes&&offset%1048576!==0)||!Number.isSafeInteger(sequence)||sequence<0){
          begin=await ssh.helper<{state:string;bytes:number;nextSequence?:number;prefixSha256?:string}>({op:'upload_reset',transferId:id},remoteTimeout);offset=0;sequence=0;
        }else{
          const expectedSequence=Math.ceil(offset/1048576);
          const prefix=await digestFilePrefix(localPath,offset);
          if(sequence!==expectedSequence||begin.prefixSha256!==prefix){
            begin=await ssh.helper<{state:string;bytes:number;nextSequence?:number;prefixSha256?:string}>({op:'upload_reset',transferId:id},remoteTimeout);offset=0;sequence=0;
          }
        }
        let sent=offset;
        for await(const chunk of createReadStream(localPath,{highWaterMark:1048576,start:offset})){
          if(signal?.aborted)throw new Fault('TRANSFER_CANCELLED','Upload was cancelled before publication');
          const args={op:'upload_chunk',transferId:id,sequence,content:Buffer.from(chunk).toString('base64')};
          stage=`chunk_${sequence}`;
          await ssh.helper(args,remoteTimeout);sequence++;sent+=chunk.length;
        }
        assert(sent===local.bytes,'TRANSFER_SOURCE_CHANGED','Staged upload changed before transfer');
        if(signal?.aborted)throw new Fault('TRANSFER_CANCELLED','Upload was cancelled before publication');
        let finished:{state:string;bytes:number;sha256:string};
        stage='finish';
        try{finished=await ssh.helper({op:'upload_finish',transferId:id},remoteTimeout);}
        catch(error){
          if(!ssh.running)throw error;
          finished=await ssh.helper({op:'upload_finish',transferId:id},remoteTimeout);
        }
        assert(finished.state==='completed'&&finished.bytes===local.bytes&&finished.sha256===local.sha256,
          'TRANSFER_UNKNOWN','Remote upload did not confirm its final checksum');
        row=this.store.put('transfer',{...row,state:'completed'});
        try{this.audit('file_upload',owner,id,'completed');}catch{return {transferId:id,state:'completed',bytes:local.bytes,sha256:local.sha256,auditWarning:'AUDIT_WRITE_FAILED'};}
        return {transferId:id,state:'completed',bytes:local.bytes,sha256:local.sha256};
      }catch(error){
        let resolved:'failed'|'completed'|'unknown'=beginAttempted||(error instanceof Fault&&error.code==='TRANSFER_CANCELLED')?'unknown':'failed';
        if(beginAttempted&&ssh.running){
          const terminalCodes=new Set(['FILE_EXISTS','INVALID_PATH','FILE_TOO_LARGE','TRANSFER_CONFLICT','INVALID_TRANSFER','INVALID_FILE']);
          const terminal=error instanceof Fault&&terminalCodes.has(error.code);
          if(!terminal)try{
              const finished=await ssh.helper<{state:string;bytes:number;sha256:string}>({op:'upload_finish',transferId:id},remoteTimeout);
              if(finished.state==='completed'&&finished.bytes===local.bytes&&finished.sha256===local.sha256)resolved='completed';
            }catch{ /* Keep an unpublished remote prefix for an identical retry. */ }
          if(terminal){
            try{
              const aborted=await ssh.helper<{state:string}>({op:'upload_abort',transferId:id},remoteTimeout);
              resolved=aborted.state==='completed'?'completed':aborted.state==='aborted'?'failed':'unknown';
            }catch(abortError){
              if(abortError instanceof Fault&&abortError.code==='TRANSFER_NOT_FOUND')resolved='failed';
            }
          }
        }
        row=this.store.put('transfer',{...row,state:resolved,reason:stage+':'+(error instanceof Fault?error.code:'TRANSFER_FAILED')});
        try{this.audit('file_upload',owner,id,resolved);}catch{/* Retain the transfer outcome; the unhealthy audit chain blocks later mutations. */}
        if(resolved==='completed')return {transferId:id,state:'completed',bytes:local.bytes,sha256:local.sha256,auditWarning:this.auditLog.healthy?undefined:'AUDIT_WRITE_FAILED'};
        if(resolved==='unknown')throw new Fault('TRANSFER_UNKNOWN','Upload outcome is uncertain; inspect the remote workspace before retrying');
        throw error;
      }
    });
  }
  async prepareViewDownload(owner:string,viewId:string,sessionId:string,path:string){
    this.validateViewFilePath(owner,viewId,sessionId,path);
    assert(this.downloads.size<Math.max(1,Math.min(4,this.config.limits.maxSessions)),'RESOURCE_LIMIT','Too many active downloads');
    const {s,r}=this.runtime(owner,sessionId),id=uid('d');this.assertAuditHealthy();
    this.audit('file_download_requested',owner,id,'accepted');
    try{
      const result=await r.ssh.helper<{transferId:string;bytes:number;sha256:string;modifiedAt:number;filename:string}>(
        {op:'download_begin',root:s.root,path,transferId:id,maxBytes:this.config.limits.maxTransferBytes},
        this.config.limits.transferTimeoutMs);
      assert(result.transferId===id&&Number.isSafeInteger(result.bytes)&&result.bytes>=0&&result.bytes<=this.config.limits.maxTransferBytes,
        'INVALID_REMOTE_RESULT','Remote download metadata is invalid');
      assert(/^[a-f0-9]{64}$/.test(result.sha256)&&typeof result.filename==='string','INVALID_REMOTE_RESULT','Remote download metadata is invalid');
      this.downloads.set(id,{owner,viewId,sessionId,bytes:result.bytes,sha256:result.sha256,filename:result.filename,nextOffset:0,touched:Date.now()});
      return {transferId:id,bytes:result.bytes,sha256:result.sha256,modifiedAt:result.modifiedAt,filename:result.filename};
    }catch(error){
      try{this.audit('file_download',owner,id,'failed');}catch{/* Read failure remains visible to the caller. */}
      throw error;
    }
  }
  async readViewDownloadChunk(owner:string,viewId:string,sessionId:string,transferId:string,offset:number){
    const transfer=this.downloads.get(transferId);
    assert(transfer&&transfer.owner===owner&&transfer.viewId===viewId&&transfer.sessionId===sessionId,'NOT_FOUND','Download is not available');
    assert(offset===transfer.nextOffset&&offset<=transfer.bytes,'INVALID_CURSOR','Download cursor is out of sequence');
    if(offset===transfer.bytes)return Buffer.alloc(0);
    const {r}=this.runtime(owner,sessionId),maximum=Math.min(2097152,transfer.bytes-offset);
    const result=await r.ssh.helper<{transferId:string;offset:number;bytes:number;base64:string}>(
      {op:'download_chunk',transferId,offset,maximum},this.config.limits.transferTimeoutMs);
    const chunk=Buffer.from(result.base64,'base64');
    assert(result.transferId===transferId&&result.offset===offset&&result.bytes===chunk.length&&chunk.length>0&&chunk.length<=maximum,
      'INVALID_REMOTE_RESULT','Remote download chunk is invalid');
    transfer.nextOffset+=chunk.length;transfer.touched=Date.now();return chunk;
  }
  async closeViewDownload(owner:string,viewId:string,sessionId:string,transferId:string,complete=false){
    const transfer=this.downloads.get(transferId);if(!transfer)return;
    assert(transfer.owner===owner&&transfer.viewId===viewId&&transfer.sessionId===sessionId,'NOT_FOUND','Download is not available');
    this.downloads.delete(transferId);
    const runtime=this.runtimes.get(sessionId);
    if(runtime?.ssh.running)await runtime.ssh.helper({op:'download_finish',transferId},this.config.limits.transferTimeoutMs).catch(()=>{});
    try{this.audit('file_download',owner,transferId,complete&&transfer.nextOffset===transfer.bytes?'completed':'closed');}catch{/* Download bytes have already been delivered or the caller disconnected. */}
  }
  private async expireDownload(id:string,transfer:DownloadTransfer){
    this.downloads.delete(id);const runtime=this.runtimes.get(transfer.sessionId);
    if(runtime?.ssh.running)await runtime.ssh.helper({op:'download_finish',transferId:id},this.config.limits.transferTimeoutMs).catch(()=>{});
    try{this.audit('file_download',transfer.owner,id,'expired');}catch{/* The audit health flag remains visible to later mutations. */}
  }
  private async sweep() {
    if(this.stopping)return;
    for(const [id,transfer]of this.downloads)if(Date.now()-transfer.touched>this.config.limits.transferTimeoutMs)await this.expireDownload(id,transfer);
    for(const [id,r]of this.runtimes) if(!r.busy&&performance.now()-r.touched>this.config.limits.idleMs){
      const s=this.store.list('session').find(s=>s.id===id); if(s)await this.closeSession(s.owner,id).catch(()=>{});
    }
    for(const c of this.store.list('command')) if(!['accepted','running','cancel_requested'].includes(c.state)&&Date.now()-c.updatedAt>this.config.limits.retentionMs){
      for(const stream of ['stdout','stderr'])rmSync(this.outputPath(c.id,stream),{force:true});
    }
  }
  async shutdown() {
    this.stopping=true; clearInterval(this.timer);
    try {
      for(const [id,r]of this.runtimes){
        if(r.commandId)await this.cancel(this.sessionOwner(id),r.commandId).catch(()=>{});
        else {await r.ssh.close(); const s=this.store.list('session').find(s=>s.id===id);if(s)this.store.put('session',{...s,state:'closed'});}
      }
      // Allow command finalizers to finish before closing SQLite and the audit chain.
      await Promise.allSettled([...this.jobs]); this.runtimes.clear();
    } finally {
      try { this.store.close(); }
      finally { this.auditLog.close(); }
    }
  }
  private sessionOwner(id:string){return this.store.list('session').find(s=>s.id===id)!.owner;}
}
