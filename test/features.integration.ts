import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ShellService } from '../src/service.js';
import { startServer } from '../src/server.js';
import { fixture } from './fixture.js';
import { Fault, quote, sleep } from '../src/core.js';

async function terminal(service:ShellService,id:string){const result=await service.waitCommand('owner',id,10000);assert.equal(result.terminal,true);return result.command;}
test('pipe stdin: progressive input, duplicate safety, EOF and persistent Bash state',{timeout:30000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  try{
    const s=await service.open('owner','test','project','pipe');
    const program='export PIPE_STATE=kept; python3 -u -c \'import sys;print("ready",flush=True);a=input();b=input();rest=sys.stdin.read();print(a+"|"+b+"|"+rest)\'';
    const c=await service.run('owner',s.id,program,'read',300,10000,'pipe');assert.equal(c.state,'running');
    assert.equal((await service.waitCommand('owner',c.id,50)).terminal,false);
    await assert.rejects(service.sendInput('other',c.id,'no\n',false,'foreign'));
    const first=await service.sendInput('owner',c.id,'unique-first\n',false,'first');assert.equal(first.state,'published');
    assert.equal((await service.sendInput('owner',c.id,'unique-first\n',false,'first')).id,first.id);
    await assert.rejects(service.sendInput('owner',c.id,'different\n',false,'first'),{code:'REQUEST_CONFLICT'});
    const second=await service.sendInput('owner',c.id,'second\nremaining',true,'second');assert.equal(second.state,'published');
    const done=await terminal(service,c.id);assert.equal(done.exitCode,0);assert.equal(done.inputSequence,2);assert.equal(done.stdinClosed,true);
    assert.equal(service.readOutput('owner',c.id,'stdout').content,'ready\nunique-first|second|remaining\n');
    await assert.rejects(service.sendInput('owner',c.id,'late',false,'late'),{code:'COMMAND_FINISHED'});
    const check=await service.run('owner',s.id,'printf "$PIPE_STATE"','retained',1000);assert.equal(check.exitCode,0);assert.equal(service.readOutput('owner',check.id,'stdout').content,'kept');
    assert.ok(!JSON.stringify(service.store.list('input')).includes('unique-first'));
    const ordinary=await service.run('owner',s.id,'sleep 1','ordinary',100);
    await assert.rejects(service.sendInput('owner',ordinary.id,'x',false,'disabled'),{code:'STDIN_DISABLED'});await terminal(service,ordinary.id);
    const slow=await service.run('owner',s.id,'cat; sleep 1','eof-window',100,10000,'pipe');
    await service.sendInput('owner',slow.id,'',true,'eof-only');
    await assert.rejects(service.sendInput('owner',slow.id,'too late',false,'after-eof'),{code:'STDIN_CLOSED'});await terminal(service,slow.id);
  }finally{await service.shutdown();await f.close();}
});

test('worker exit in pipe mode does not leave its stdin feeder running',{timeout:30000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  type ProbeSSH={remoteDir:string;exec:(command:string)=>Promise<{stdout:string}>};
  const internal=service as unknown as {runtimes:Map<string,{ssh:ProbeSSH}>};
  try{
    const s=await service.open('owner','test','project','exit-with-input');
    const ssh=internal.runtimes.get(s.id)!.ssh;
    const identity=JSON.parse((await ssh.exec(`cat ${quote(ssh.remoteDir+'/identity')}`)).stdout) as {pid:number};
    const c=await service.run('owner',s.id,'exit 7','exit',100,10000,'pipe');
    assert.equal((await terminal(service,c.id)).state,'unknown');
    await sleep(200);const next=await service.reopen('owner',s.id,'new');
    const scan=`import os\ngroup=${identity.pid}\nfound=[]\nfor p in os.listdir('/proc'):\n if not p.isdigit(): continue\n try:\n  if os.getpgid(int(p))==group and open('/proc/'+p+'/stat').read().rsplit(')',1)[1].split()[0]!='Z': found.append(p)\n except (OSError,ProcessLookupError): pass\nprint(','.join(found))`;
    const probe=await service.run('owner',next.id,`python3 -c ${quote(scan)}`,'inspect',1000);assert.equal(probe.exitCode,0);
    assert.equal(service.readOutput('owner',probe.id,'stdout').content.trim(),'');
  }finally{await service.shutdown();await f.close();}
});

test('input caps and cancel/reopen create a fresh generation without replay',{timeout:30000},async()=>{
  const f=await fixture();f.config.limits.maxInputBytes=5;f.config.limits.maxInputMessages=2;const service=new ShellService(f.config);
  try{
    const s=await service.open('owner','test','project','original');
    await assert.rejects(service.reopen('owner',s.id,'live'),{code:'SESSION_ACTIVE'});
    const c=await service.run('owner',s.id,'export OLD_STATE=lost; echo once >> count; cat','cat',100,10000,'pipe');
    await service.sendInput('owner',c.id,'1234',false,'one');
    await assert.rejects(service.sendInput('owner',c.id,'67',false,'over'),{code:'INPUT_LIMIT'});
    await assert.rejects(service.sendInput('owner',c.id,'😀'.repeat(5000),false,'oversize'),{code:'INPUT_LIMIT'});
    await service.sendInput('owner',c.id,'5',false,'two');
    await assert.rejects(service.sendInput('owner',c.id,'',true,'message-cap'),{code:'INPUT_LIMIT'});
    const cancel=await service.cancel('owner',c.id);assert.equal(cancel.state,'cancelled');
    const next=await service.reopen('owner',s.id,'again');assert.notEqual(next.id,s.id);assert.equal(next.generation,2);assert.equal(next.previousSessionId,s.id);
    assert.equal((await service.reopen('owner',s.id,'again')).id,next.id);
    const check=await service.run('owner',next.id,'printf "${OLD_STATE-unset}"; cat count','verify',1000);assert.equal(check.exitCode,0);
    assert.equal(service.readOutput('owner',check.id,'stdout').content,'unsetonce\n');assert.equal(service.command('owner',c.id).state,'cancelled');
  }finally{await service.shutdown();await f.close();}
});

test('bounded literal search and stable history pages include scope checks',{timeout:30000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  try{
    mkdirSync(join(f.root,'.venv'));writeFileSync(join(f.root,'.venv/skip'),'needle\n');
    writeFileSync(join(f.root,'a.txt'),'needle first\nNeedle second\nneedle third\n');
    writeFileSync(join(f.root,'b.txt'),'needle fourth\n');writeFileSync(join(f.root,'binary'),Buffer.from([0,255]));
    writeFileSync(join(f.root,'unicode.txt'),'İstanbul');
    symlinkSync('/etc',join(f.root,'outside'));writeFileSync(join(f.root,'large'),'x'.repeat(1048577));
    const s=await service.open('owner','test','project','search');
    const first=await service.searchFiles('owner',s.id,'needle','.',false,0,2) as {matches:{path:string;line:number}[];nextCursor:number;incomplete:boolean;limitations:string[]};
    assert.deepEqual(first.matches.map(m=>[m.path,m.line]),[['a.txt',1],['a.txt',2]]);assert.equal(first.nextCursor,2);
    const second=await service.searchFiles('owner',s.id,'needle','.',false,first.nextCursor,2) as typeof first;
    assert.deepEqual(second.matches.map(m=>[m.path,m.line]),[['a.txt',3],['b.txt',1]]);assert.equal(second.incomplete,true);assert.ok(second.limitations.includes('large_file'));
    await assert.rejects(service.searchFiles('owner',s.id,'root','outside'),{code:'INVALID_PATH'});
    const unicode=await service.searchFiles('owner',s.id,'STANBUL','unicode.txt',false) as {matches:{column:number}[]};assert.equal(unicode.matches[0].column,2);
    const ids=[];for(let i=0;i<3;i++)ids.push((await service.run('owner',s.id,`printf ${i}`,`job-${i}`,1000)).id);
    const page=service.listCommands('owner',s.id,undefined,0,2);assert.deepEqual(page.commands.map(c=>c.id),ids.slice(0,2));assert.ok(page.nextCursor);
    const rest=service.listCommands('owner',s.id,'completed',page.nextCursor!,2);assert.deepEqual(rest.commands.map(c=>c.id),ids.slice(2));
    await assert.rejects(service.waitCommand('other',ids[0],0));assert.throws(()=>service.listCommands('other',s.id,undefined));
  }finally{await service.shutdown();await f.close();}
});

test('lost input acknowledgement never automatically publishes a duplicate',{timeout:30000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  try{
    const s=await service.open('owner','test','project','uncertain');
    const c=await service.run('owner',s.id,'cat','waiting',100,10000,'pipe');
    const internal=service as unknown as {runtimes:Map<string,{ssh:{helper:(args:Record<string,unknown>)=>Promise<unknown>}}>};
    const ssh=internal.runtimes.get(s.id)!.ssh, original=ssh.helper.bind(ssh);let published=0;
    // The publication itself uses real SSH. Only its ACK is deliberately lost.
    ssh.helper=async args=>{const result=await original(args);if(args.op==='input'){published++;throw new Fault('ACK_LOST','Injected lost acknowledgement');}return result;};
    const input=await service.sendInput('owner',c.id,'once',false,'uncertain');assert.equal(input.state,'unknown');
    assert.equal((await service.sendInput('owner',c.id,'once',false,'uncertain')).id,input.id);assert.equal(published,1);
    await assert.rejects(service.sendInput('owner',c.id,'more',true,'new'),{code:'INPUT_UNCERTAIN'});
    ssh.helper=original;await service.cancel('owner',c.id);
  }finally{await service.shutdown();await f.close();}
});

test('HTTP MCP exposes and executes all five new tools',{timeout:30000},async()=>{
  const f=await fixture();process.env.SHELL_MCP_TEST_TOKEN='feature-http-token-'.repeat(3);const runtime=await startServer(f.config);
  const port=(runtime.server.address() as {port:number}).port;
  const client=new Client({name:'v02-http',version:'1'},{versionNegotiation:{mode:'auto'}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+process.env.SHELL_MCP_TEST_TOKEN}}}));
    const names=(await client.listTools()).tools.map(t=>t.name);assert.equal(names.length,20);
    for(const name of ['send_input','wait_command','search_files','list_commands','reopen_session'])assert.ok(names.includes(name));
    const call=async(name:string,args:Record<string,unknown>)=>{const response=await client.callTool({name,arguments:args});assert.ok(!response.isError,JSON.stringify(response));return(response.structuredContent as {result:Record<string,unknown>}).result;};
    const s=await call('open_session',{targetId:'test',workspaceId:'project',clientRequestId:'http'});
    const c=await call('run_command',{sessionId:s.id,command:'read -r value; printf "$value"',inputMode:'pipe',clientRequestId:'cmd',waitMs:100});
    await call('send_input',{commandId:c.id,data:'hello\n',end:true,clientRequestId:'input'});
    const done=await call('wait_command',{commandId:c.id,waitMs:5000});assert.equal(done.terminal,true);
    const history=await call('list_commands',{sessionId:s.id});assert.equal((history.commands as unknown[]).length,1);
    writeFileSync(join(f.root,'search.txt'),'hello MCP');
    const found=await call('search_files',{sessionId:s.id,query:'MCP'});assert.equal((found.matches as unknown[]).length,1);
    await call('close_session',{sessionId:s.id});
    const next=await call('reopen_session',{sessionId:s.id,clientRequestId:'next'});assert.equal(next.generation,2);
  }finally{await client.close();await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
});
