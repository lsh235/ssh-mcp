import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ShellService } from '../src/service.js';
import { parseConfig } from '../src/config.js';
import { loginValues } from '../src/gateway.js';
import { startServer } from '../src/server.js';
import { fixture } from './fixture.js';
import { sleep, quote } from '../src/core.js';

// Artificial fixture data only. Keep real gate credentials out of this file.
const username='fixture-user';
const password='fixture $() ` ~\\! 한글';
const gate=`import os,sys,time,pathlib,termios
if os.environ.get('SSH_ORIGINAL_COMMAND'): sys.exit(90)
if not sys.stdin.isatty(): sys.exit(91)
# Deliberately enable echo: even echoed secrets must never become MCP output.
attrs=termios.tcgetattr(0);attrs[3]|=termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,attrs)
path=pathlib.Path(__file__).with_name('visits')
with path.open('a') as f: f.write('visit\\n')
sys.stdout.write('\\x1b[32mLogin ');sys.stdout.flush();time.sleep(.03)
sys.stdout.write('ID:\\x1b[0m ');sys.stdout.flush()
user=sys.stdin.readline().rstrip('\\r\\n')
sys.stdout.write('Access phrase: ');sys.stdout.flush()
secret=sys.stdin.readline().rstrip('\\r\\n')
if user!=${JSON.stringify(username)} or secret!=${JSON.stringify(password)}:
 print('REJECTED',flush=True);sys.exit(92)
os.environ['GATE_TEST_USER']=user
os.environ['GATE_TEST_SECRET']=secret
os.environ['PS1']='GATE_READY> '
os.environ['HISTFILE']='/dev/null'
os.execvp('bash',['bash','--noprofile','--norc','-i'])
`;
function configured(f:Awaited<ReturnType<typeof fixture>>,expect='Login ID:'){
  const privateFile=join(f.dir,'gate-password');writeFileSync(privateFile,password+'\n',{mode:0o600});
  process.env.SHELL_MCP_FIXTURE_GATE_USER=username;
  return parseConfig({...f.config,targets:{test:{...f.config.targets.test,postLogin:{
    steps:[{expect,valueFrom:{env:'SHELL_MCP_FIXTURE_GATE_USER'}},{expect:'Access phrase:',valueFrom:{file:privateFile}}],ready:'GATE_READY> ',timeoutMs:1000
  }}}});
}
async function done(s:ShellService,id:string){const r=await s.waitCommand('owner',id,10000);assert.equal(r.terminal,true);assert.equal(r.command.state,'completed');return r.command;}
function scan(dir:string):string{
  return readdirSync(dir,{withFileTypes:true}).map(p=>p.isDirectory()?scan(join(dir,p.name)):readFileSync(join(dir,p.name)).toString('utf8')).join('');
}
test('post-SSH gate: two prompt inputs, same-channel files/git/commands, stdin and persistent state',{timeout:45000},async()=>{
  const f=await fixture({gate}),config=configured(f),s=new ShellService(config);
  try{
    const session=await s.open('owner','test','project','gate-open');
    assert(!JSON.stringify(s.listTargets('owner')).includes('valueFrom'));
    const secretOutput=await s.run('owner',session.id,`python3 -c 'import os,sys,time; s=os.environ["GATE_TEST_SECRET"]; n=len(s)//2; sys.stdout.write(s[:n]); sys.stdout.flush(); time.sleep(.45); sys.stdout.write(s[n:]); sys.stdout.flush()'; printf '%s' "$GATE_TEST_USER" >&2`,'gate-secret-output',100,10000);
    assert.equal((await done(s,secretOutput.id)).exitCode,0);
    assert.equal(s.readOutput('owner',secretOutput.id,'stdout').content,'*'.repeat(Buffer.byteLength(password)));
    assert.equal(s.readOutput('owner',secretOutput.id,'stderr').content,'*'.repeat(Buffer.byteLength(username)));
    assert.equal(s.command('owner',secretOutput.id).stdoutBytes,Buffer.byteLength(password));
    writeFileSync(join(f.root,'example.txt'),'before\n');
    const file=await s.readFile('owner',session.id,'example.txt') as {version:string};
    await s.patch('owner',session.id,'--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n',{'example.txt':file.version},'patch');
    assert.equal((await s.readFile('owner',session.id,'example.txt') as {content:string}).content,'after\n');
    const view=s.createSessionView('owner',[session.id],'gate transfer','gate-view');
    assert.equal(s.viewOutput('owner',view.viewId,secretOutput.id,'stdout',0).content,'*'.repeat(Buffer.byteLength(password)));
    const payload=Buffer.alloc(4097);for(let i=0;i<payload.length;i++)payload[i]=(i*19+3)%256;
    const localUpload=join(f.dir,'gate-upload.bin');writeFileSync(localUpload,payload);
    const uploaded=await s.uploadViewFile('owner',view.viewId,session.id,'gate-upload.bin',localUpload,'gate-upload-request');
    assert.equal(uploaded.state,'completed');assert.deepEqual(readFileSync(join(f.root,'gate-upload.bin')),payload);
    const download=await s.prepareViewDownload('owner',view.viewId,session.id,'gate-upload.bin'),parts:Buffer[]=[];let offset=0;
    while(offset<download.bytes){const chunk=await s.readViewDownloadChunk('owner',view.viewId,session.id,download.transferId,offset);parts.push(chunk);offset+=chunk.length;}
    assert.deepEqual(Buffer.concat(parts),payload);await s.closeViewDownload('owner',view.viewId,session.id,download.transferId,true);
    const c=await s.run('owner',session.id,'export GATE_STATE=kept; mkdir sub; cd sub; python3 -c "print(123)"','first',100,10000);
    assert.equal((await done(s,c.id)).exitCode,0);
    const c2=await s.run('owner',session.id,'printf "%s\\n" "$GATE_STATE"; pwd; git init -q .; git status --porcelain','second',100,10000);
    assert.equal((await done(s,c2.id)).exitCode,0);
    assert.equal(s.readOutput('owner',c2.id,'stdout').content,`kept\n${f.root}/sub\n`);
    const pipe=await s.run('owner',session.id,'python3 -u -c "print(input())"','pipe',250,10000,'pipe');
    assert.equal(pipe.state,'running');
    await s.sendInput('owner',pipe.id,'hello gate\n',true,'stdin');assert.equal((await done(s,pipe.id)).exitCode,0);
    assert.equal(s.readOutput('owner',pipe.id,'stdout').content,'hello gate\n');
    const git=await s.run('owner',session.id,'cd ..; git init -q .','git-init',100,10000);await done(s,git.id);
    assert((await s.git('owner',session.id,'status')).output.includes('example.txt'));
    // Large payload exceeds the canonical PTY line length and must round-trip intact.
    writeFileSync(join(f.root,'large.txt'),'한글'.repeat(12000));
    assert.equal((await s.readFile('owner',session.id,'large.txt') as {content:string}).content,'한글'.repeat(12000));
    await s.closeSession('owner',session.id);
    assert.equal(readFileSync(join(f.dir,'visits'),'utf8'),'visit\n');
    const records=scan(config.stateDir);assert(!records.includes(password));assert(!records.includes(username));
    const reopened=await s.reopen('owner',session.id,'again');assert.equal(reopened.generation,2);
    assert.equal(readFileSync(join(f.dir,'visits'),'utf8'),'visit\nvisit\n');await s.closeSession('owner',reopened.id);
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('post-SSH gate: terminal commands reuse the authenticated channel and preserve output masking',{timeout:30000},async()=>{
  const f=await fixture({gate}),config=configured(f),s=new ShellService(config);
  try{
    const session=await s.open('owner','test','project','gate-pty');
    const code="import os,time; print('READY:%s:%s'%(os.isatty(0),os.getenv('GATE_TEST_USER')),flush=True); print('SECRET:'+os.getenv('GATE_TEST_SECRET'),flush=True); time.sleep(30)";
    const terminal=await s.openTerminal('owner',session.id,`python3 -u -c ${quote(code)}`,'gate-pty-command',24,80,250,20000);
    let cursor=0,output='';const deadline=Date.now()+8000;
    while(Date.now()<deadline&&(output.split('SECRET:')[1]?.trim().length??0)<Buffer.byteLength(password)){const page=s.readOutput('owner',terminal.id,'stdout',cursor,32768);cursor=page.nextCursor;output+=page.content;await sleep(50);}
    assert.match(output,new RegExp(`READY:True:${'\\*'.repeat(Buffer.byteLength(username))}`));assert.equal(output.split('SECRET:')[1]?.trim(),'*'.repeat(Buffer.byteLength(password)));
    await s.closeTerminal('owner',terminal.id,'gate-pty-close');assert.equal((await done(s,terminal.id)).state,'completed');
    const after=await s.run('owner',session.id,'printf "%s" "$GATE_TEST_USER"','gate-after-pty',1000,10000);
    assert.equal(after.exitCode,0);assert.equal(s.readOutput('owner',after.id,'stdout').content,'*'.repeat(Buffer.byteLength(username)));
    await s.closeSession('owner',session.id);
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('unmatched gate prompt times out without sending later input or exposing banners',{timeout:20000},async()=>{
  const f=await fixture({gate}),config=configured(f,'Never shown:');config.targets.test.postLogin!.timeoutMs=150;
  const s=new ShellService(config);
  try{
    await assert.rejects(s.open('owner','test','project','timeout'),{code:'LOGIN_TIMEOUT'});
    const session=s.listSessions('owner')[0];assert.equal(session.state,'broken');
    const records=scan(config.stateDir);assert(!records.includes(password));assert(!records.includes(username));assert(!records.includes('Login ID:'));
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('secret references reject inline values, missing env, public/symlink/multiline files and controls',async()=>{
  const f=await fixture();
  try{
    const base={steps:[{expect:'ID:',valueFrom:{env:'MISSING_SHELL_GATE_TEST'}}],ready:'Ready:',lineEnding:'lf' as const};
    delete process.env.MISSING_SHELL_GATE_TEST;
    assert.throws(()=>loginValues({...base,timeoutMs:100}),{code:'LOGIN_SECRET_UNAVAILABLE'});
    for(const valueFrom of [{value:'inline'},{env:'GOOD',value:'inline'},{file:'relative'}]){
      assert.throws(()=>parseConfig({...f.config,targets:{test:{...f.config.targets.test,postLogin:{...base,steps:[{expect:'ID:',valueFrom}]}}}}));
    }
    const file=join(f.dir,'secret');writeFileSync(file,'dummy',{mode:0o644});
    const cfg={...base,timeoutMs:100,steps:[{expect:'ID:',valueFrom:{file}}]};
    assert.throws(()=>loginValues(cfg),{code:'LOGIN_SECRET_UNAVAILABLE'});
    const link=join(f.dir,'link');symlinkSync(file,link);assert.throws(()=>loginValues({...cfg,steps:[{expect:'ID:',valueFrom:{file:link}}]}),{code:'LOGIN_SECRET_UNAVAILABLE'});
    const multiline=join(f.dir,'lines');writeFileSync(multiline,'a\nb\n',{mode:0o600});
    assert.throws(()=>loginValues({...cfg,steps:[{expect:'ID:',valueFrom:{file:multiline}}]}),{code:'LOGIN_SECRET_INVALID'});
    process.env.MISSING_SHELL_GATE_TEST='a\x03b';assert.throws(()=>loginValues({...base,timeoutMs:100}),{code:'LOGIN_SECRET_INVALID'});
  }finally{delete process.env.MISSING_SHELL_GATE_TEST;await f.close();}
});
test('actual HTTP MCP gate cancellation confirms termination; reopen logs in again',{timeout:45000},async()=>{
  const f=await fixture({gate}),config=configured(f);process.env.SHELL_MCP_TEST_TOKEN='test-gate-token-value-at-least-32-bytes';
  const runtime=await startServer(config),client=new Client({name:'gate-http-test',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+process.env.SHELL_MCP_TEST_TOKEN}}}));
    const call=async(name:string,args:Record<string,unknown>)=>{const response=await client.callTool({name,arguments:args});assert(!response.isError,JSON.stringify(response.structuredContent));return (response.structuredContent as {result:Record<string,unknown>}).result;};
    const session=await call('open_session',{targetId:'test',workspaceId:'project',clientRequestId:'http-open'});
    const job=await call('run_command',{sessionId:session.sessionId,command:'sleep 30',clientRequestId:'long',waitMs:200});
    const result=await call('cancel_command',{commandId:job.commandId});assert.equal(result.state,'cancelled');
    const next=await call('reopen_session',{sessionId:session.sessionId,clientRequestId:'new-generation'});assert.equal(next.generation,2);
    await call('close_session',{sessionId:next.sessionId});
  }finally{await client.close();await runtime.stop();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;delete process.env.SHELL_MCP_TEST_TOKEN;}
});
test('wrong gate value fails closed and cannot start helpers or leak echoed values',{timeout:20000},async()=>{
  const f=await fixture({gate}),config=configured(f);process.env.SHELL_MCP_FIXTURE_GATE_USER='wrong-fixture-user';
  const s=new ShellService(config);
  try{
    await assert.rejects(s.open('owner','test','project','wrong'),e=>typeof e==='object'&&e!==null&&'code' in e&&['GATEWAY_DISCONNECTED','LOGIN_TIMEOUT'].includes(e.code as string));
    assert.equal(s.listSessions('owner')[0].state,'broken');
    const records=scan(config.stateDir);for(const v of [username,password,'wrong-fixture-user','REJECTED'])assert(!records.includes(v));
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('master disconnect makes gate command unknown and terminates its remote worker group',{timeout:30000},async()=>{
  const f=await fixture({gate}),config=configured(f),s=new ShellService(config);
  try{
    const session=await s.open('owner','test','project','disconnect');
    const internals=s as unknown as {runtimes:Map<string,{ssh:{remoteDir:string;exec:(command:string)=>Promise<{stdout:string}>;master:{kill:(signal:string)=>void}}}>};
    const ssh=internals.runtimes.get(session.id)!.ssh;
    const identity=JSON.parse((await ssh.exec(`cat ${quote(ssh.remoteDir+'/identity')}`)).stdout) as {pid:number};
    const c=await s.run('owner',session.id,'sleep 30','sleep',200,10000);
    ssh.master.kill('SIGKILL');
    for(let i=0;i<40&&s.command('owner',c.id).state!=='unknown';i++)await sleep(50);
    assert.equal(s.command('owner',c.id).state,'unknown');assert.equal(s.command('owner',c.id).exitCode,null);
    for(let i=0;i<60&&existsSync(`/proc/${identity.pid}`);i++){
      if(readFileSync(`/proc/${identity.pid}/stat`,'utf8').split(')')[1].trim().startsWith('Z'))break;
      await sleep(50);
    }
    if(existsSync(`/proc/${identity.pid}`)){
      const stat=readFileSync(`/proc/${identity.pid}/stat`,'utf8').split(')')[1].trim().split(' ');
      assert(stat[0]==='Z');
    }
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('gate helper output limits and deadlines remain enforced on the shared channel',{timeout:20000},async()=>{
  const f=await fixture({gate}),config=configured(f),s=new ShellService(config);
  try{
    const session=await s.open('owner','test','project','bounded');
    const ssh=(s as unknown as {runtimes:Map<string,{ssh:{exec:(command:string,input:string,max:number,timeout:number)=>Promise<unknown>}}>}).runtimes.get(session.id)!.ssh;
    await assert.rejects(ssh.exec("python3 -c 'print(100000*chr(120))'",'',1024,2000),{code:'OUTPUT_LIMIT'});
    await assert.rejects(ssh.exec('sleep 10','',1024,100),{code:'REMOTE_TIMEOUT'});
    const c=await s.run('owner',session.id,'echo still-alive; printf stderr >&2; false','after-limit',100,10000);
    assert.equal((await done(s,c.id)).exitCode,1);assert.equal(s.readOutput('owner',c.id,'stderr').content,'stderr');
    await s.closeSession('owner',session.id);
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('gate target and ordinary SSH target remain independent in one MCP service',{timeout:30000},async()=>{
  const gated=await fixture({gate}),plain=await fixture(),config=configured(gated);
  config.targets.ordinary=plain.config.targets.test;
  const s=new ShellService(config);
  try{
    const a=await s.open('owner','test','project','gated');
    const b=await s.open('owner','ordinary','project','ordinary');
    const [ca,cb]=await Promise.all([
      s.run('owner',a.id,'export WHERE=gate; sleep .2; echo "$WHERE"','ca',0,10000),
      s.run('owner',b.id,'export WHERE=ordinary; sleep .2; echo "$WHERE"','cb',0,10000)
    ]);
    await Promise.all([done(s,ca.id),done(s,cb.id)]);
    assert.equal(s.readOutput('owner',ca.id,'stdout').content,'gate\n');
    assert.equal(s.readOutput('owner',cb.id,'stdout').content,'ordinary\n');
    assert.equal(s.listSessions('owner').length,2);assert.equal(readFileSync(join(gated.dir,'visits'),'utf8'),'visit\n');
    await s.closeSession('owner',a.id);await s.closeSession('owner',b.id);
  }finally{await s.shutdown();await gated.close();await plain.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
test('login values alone cannot bypass the explicit shell-ready check',{timeout:20000},async()=>{
  const f=await fixture({gate}),config=configured(f);config.targets.test.postLogin!.ready='NEVER_READY>';config.targets.test.postLogin!.timeoutMs=150;
  const s=new ShellService(config);
  try{
    await assert.rejects(s.open('owner','test','project','not-ready'),{code:'LOGIN_TIMEOUT'});
    assert.equal(s.listSessions('owner')[0].state,'broken');
    assert(!scan(config.stateDir).includes(password));
  }finally{await s.shutdown();await f.close();delete process.env.SHELL_MCP_FIXTURE_GATE_USER;}
});
