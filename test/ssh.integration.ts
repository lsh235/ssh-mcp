import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, symlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ShellService } from '../src/service.js';
import { startServer } from '../src/server.js';
import { sleep } from '../src/core.js';
import { fixture } from './fixture.js';

async function wait(service:ShellService,id:string,owner='owner',timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const c=service.command(owner,id);if(!['accepted','running','cancel_requested'].includes(c.state))return c;await sleep(50);}throw new Error('Command did not complete');}
test('real OpenSSH: persistent shell, patch/test loop, output, deduplication, failures and isolation',{timeout:60000},async()=>{
  const f=await fixture(), service=new ShellService(f.config);
  try {
    execFileSync('git',['init','-q',f.root]);
    writeFileSync(join(f.root,'sum.py'),'def add(a, b):\n    return a - b\n');
    symlinkSync('/etc',join(f.root,'outside'));
    const s=await service.open('owner','test','project','open1');
    assert.equal(s.state,'ready');assert.equal((await service.open('owner','test','project','open1')).id,s.id);
    await assert.rejects(service.open('other','test','project','denied'));
    const run=async(text:string,key:string)=>{const c=await service.run('owner',s.id,text,key,50);return wait(service,c.id);};
    assert.equal((await run("mkdir -p sub; cd sub; export RETAINED='works'",'cwd')).exitCode,0);
    const env=await run('printf "%s:%s" "$PWD" "$RETAINED"','env');
    assert.match(service.readOutput('owner',env.id,'stdout').content,/\/sub:works$/);
    await run(`cd ..; python3 -m venv --without-pip .venv; source .venv/bin/activate`,'venv');
    const py=await run('python -B -c "import sys;print(sys.prefix)"','prefix');assert.match(service.readOutput('owner',py.id,'stdout').content,/\.venv/);
    assert.equal((await run('OLDPATH=$PATH; export PATH=/nonexistent; printf preserved','path-change')).exitCode,0);
    assert.equal((await run('export PATH=$OLDPATH','path-restore')).exitCode,0);
    const failed=await run('python -B -c "from sum import add;assert add(2,3)==5"','fail');assert.equal(failed.exitCode,1);
    const file=await service.readFile('owner',s.id,'sum.py');
    await assert.rejects(service.patch('owner',s.id,'--- a/sum.py\n+++ b/sum.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n',{'sum.py':'0'.repeat(64)},'conflict'));
    const patched=await service.patch('owner',s.id,'--- a/sum.py\n+++ b/sum.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n',{'sum.py':file.version},'patch1');assert.equal(patched.state,'applied');
    const success=await run('python -B -c "from sum import add;assert add(2,3)==5"','pass');assert.equal(success.exitCode,0);
    const once=await run('echo x >> count.txt; printf error >&2; exit_code=7; false','once');assert.equal(once.exitCode,1);
    assert.equal((await service.run('owner',s.id,'echo x >> count.txt; printf error >&2; exit_code=7; false','once',50)).id,once.id);
    assert.equal(readFileSync(join(f.root,'count.txt'),'utf8'),'x\n');
    assert.equal(service.readOutput('owner',once.id,'stderr').content,'error');
    await assert.rejects(service.run('owner',s.id,'true','once'));
    assert.throws(()=>service.command('other',once.id));
    await assert.rejects(service.readFile('owner',s.id,'../host'));await assert.rejects(service.readFile('owner',s.id,'outside/passwd'));
    const busy=await service.run('owner',s.id,'sleep 1; echo finished','busy',0);
    await assert.rejects(service.run('owner',s.id,'echo second','second',0));await wait(service,busy.id);
    const bad=await run('exit 7','exit');assert.equal(bad.state,'unknown');assert.equal(bad.exitCode,null);
    assert.equal(service.session('owner',s.id).state,'broken');
    await service.closeSession('owner',s.id);
    const s2=await service.open('owner','test','project','open2');
    const long=await service.run('owner',s2.id,'sleep 30','cancel',0);
    await sleep(300);const cancelled=await service.cancel('owner',long.id);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.shellStatePreserved,false);
  } finally {await service.shutdown();await f.close();}
});

test('multi-file patch reports a real partial filesystem failure',{timeout:30000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  try{
    execFileSync('mkdir',['-p',join(f.root,'restricted')]);
    writeFileSync(join(f.root,'first'),'old\n');writeFileSync(join(f.root,'restricted/second'),'old\n');
    const s=await service.open('owner','test','project','partial');
    const first=await service.readFile('owner',s.id,'first'),second=await service.readFile('owner',s.id,'restricted/second');
    execFileSync('chmod',['555',join(f.root,'restricted')]);
    const result=await service.patch('owner',s.id,'--- a/first\n+++ b/first\n@@ -1 +1 @@\n-old\n+new\n--- a/restricted/second\n+++ b/restricted/second\n@@ -1 +1 @@\n-old\n+new\n',{'first':first.version,'restricted/second':second.version},'partial-patch');
    assert.equal(result.state,'partial_apply');assert.equal(readFileSync(join(f.root,'first'),'utf8'),'new\n');assert.equal(readFileSync(join(f.root,'restricted/second'),'utf8'),'old\n');
  }finally{execFileSync('chmod',['755',join(f.root,'restricted')]);await service.shutdown();await f.close();}
});

test('real HTTP MCP client: authentication, remote commands and reconnect without replay',{timeout:30000},async()=>{
  const f=await fixture();process.env.SHELL_MCP_TEST_TOKEN='fixture-token-'.repeat(4); const runtime=await startServer(f.config);
  const port=(runtime.server.address() as {port:number}).port,url=new URL(`http://127.0.0.1:${port}/mcp`);
  const connect=async()=>{const client=new Client({name:'integration',version:'1.0'});await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+process.env.SHELL_MCP_TEST_TOKEN}}}));return client;};
  let client:Client|undefined;
  try {
    assert.equal((await fetch(url,{method:'POST'})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
    const badHost=await new Promise<number|undefined>((resolve,reject)=>{
      const req=request(url,{method:'POST',headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
    });
    assert.equal(badHost,403);
    const legacy=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+process.env.SHELL_MCP_TEST_TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-probe',version:'1.0'}}})});
    assert.equal(legacy.status,200);assert.match(await legacy.text(),/2025-11-25/);
    client=await connect();assert.equal((await client.listTools()).tools.length,20);
    const call=async(name:string,args:Record<string,unknown>)=>{
      const r=await client!.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return (r.structuredContent as {result:Record<string,unknown>}).result;
    };
    const s=await call('open_session',{targetId:'test',workspaceId:'project',clientRequestId:'httpopen'});
    const c=await call('run_command',{sessionId:s.id,command:'sleep 1; echo once >> http-count',clientRequestId:'httpjob',waitMs:0});
    await client.close();client=await connect();
    const again=await call('run_command',{sessionId:s.id,command:'sleep 1; echo once >> http-count',clientRequestId:'httpjob',waitMs:0});assert.equal(again.id,c.id);
    await wait(runtime.service,c.id as string);assert.equal(readFileSync(join(f.root,'http-count'),'utf8'),'once\n');
    assert.equal((await call('get_command',{commandId:c.id})).exitCode,0);
    const abort=new AbortController();
    const lost=client.callTool({name:'run_command',arguments:{sessionId:s.id,command:'sleep 1; echo survived >> dropped-response',clientRequestId:'lost-response',waitMs:10000}},{signal:abort.signal}).catch(()=>undefined);
    await sleep(150);abort.abort();await lost;
    const admitted=await call('get_command',{sessionId:s.id,clientRequestId:'lost-response'});
    await wait(runtime.service,admitted.id as string);
    const same=await call('run_command',{sessionId:s.id,command:'sleep 1; echo survived >> dropped-response',clientRequestId:'lost-response',waitMs:10000});
    assert.equal(same.id,admitted.id);assert.equal(readFileSync(join(f.root,'dropped-response'),'utf8'),'survived\n');
    await call('close_session',{sessionId:s.id});
  }finally{await client?.close();await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
});

test('SSH transport loss is uncertain and host key checking cannot be bypassed',{timeout:30000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  try{
    const s=await service.open('owner','test','project','disconnect');
    const c=await service.run('owner',s.id,'echo entered; sleep 1; echo once >> disconnected','disconnected',0);
    await sleep(250);
    // Kill this fixture's actual OpenSSH master; no mocked SSH adapter.
    const internals=service as unknown as {runtimes:Map<string,{ssh:{master:{kill:(signal:string)=>void}}}>};
    internals.runtimes.get(s.id)!.ssh.master.kill('SIGKILL');
    const result=await wait(service,c.id);assert.equal(result.state,'unknown');assert.equal(result.exitCode,null);
    assert.equal((await service.run('owner',s.id,'echo entered; sleep 1; echo once >> disconnected','disconnected',0)).id,c.id);
    await sleep(1200);assert.equal(readFileSync(join(f.root,'disconnected'),'utf8'),'once\n');
    await service.closeSession('owner',s.id);
    writeFileSync(join(f.dir,'known_hosts'),'');
    await assert.rejects(service.open('owner','test','project','untrusted'),error=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='HOST_KEY_UNTRUSTED'));
  }finally{await service.shutdown();await f.close();}
});

test('remote deadline and bounded output are explicit',{timeout:30000},async()=>{
  const f=await fixture();f.config.limits.maxOutputBytes=4096;const service=new ShellService(f.config);
  try{
    const s=await service.open('owner','test','project','limits');
    const out=await service.run('owner',s.id,"python3 -c 'import sys;sys.stdout.write(\"x\"*20000)'",'output',50);
    const result=await wait(service,out.id);assert.equal(result.state,'completed');assert.equal(result.exitCode,0);assert.equal(result.truncated,true);assert.equal(result.stdoutBytes,4096);assert.equal(result.outputComplete,false);
    const artifact=await service.run('owner',s.id,"python3 -c 'open(\"artifact.bin\",\"wb\").write(b\"x\"*100000)'",'build-artifact',3000);
    assert.equal(artifact.exitCode,0);assert.equal(statSync(join(f.root,'artifact.bin')).size,100000);
    await service.closeSession('owner',s.id);
    const s2=await service.open('owner','test','project','deadline');
    const c=await service.run('owner',s2.id,'sleep 30','timeout',0,200);
    assert.equal((await wait(service,c.id)).state,'timed_out');
  }finally{await service.shutdown();await f.close();}
});
