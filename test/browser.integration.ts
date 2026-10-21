import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../src/server.js';
import { fixture } from './fixture.js';
import { quote } from '../src/core.js';

const token='browser-fixture-only-token-at-least-32-bytes';
test('browser view: real SSH + MCP creation, bounded history/output, auth and explicit conversation scope',{timeout:30000},async()=>{
  const f=await fixture();process.env.SHELL_MCP_TEST_TOKEN=token;
  const second=join(f.dir,'second');mkdirSync(second);
  f.config.targets.other={...f.config.targets.test,workspaces:{project:second}};
  const runtime=await startServer(f.config),service=runtime.service;
  const base=`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}`;
  f.config.publicUrl=base+'/mcp';
  const client=new Client({name:'browser-view-proof',version:'0.4.0'});
  const get=(path:string,auth=true,origin?:string)=>fetch(base+path,{headers:{...(auth?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    assert((await client.listTools()).tools.some(t=>t.name==='create_session_view'));
    const s=await service.open('owner','test','project','first');
    const other=await service.open('owner','other','project','second');
    const result=await client.callTool({name:'create_session_view',arguments:{sessionIds:[s.id],label:'현재 대화 <script> fixture',clientRequestId:'view-1'}});
    assert(!result.isError);const view=(result.structuredContent as {result:{viewId:string;url:string}}).result;
    assert.equal(view.url,base+'/sessions#'+view.viewId);assert(!view.url.includes(token));
    const path='/viewer-api/views/'+view.viewId;
    assert.equal((await get(path,false)).status,401);
    assert.equal((await get(path,true,'https://untrusted.example')).status,403);
    assert.equal((await get(path,true,base)).status,200);
    assert.equal((await get('/session-assets/app.js',false,base)).status,200);
    assert.equal((await get('/session-assets/app.js',false,'https://untrusted.example')).status,403);
    // The viewer's same-origin exception must not weaken MCP origin validation.
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{Origin:base,Authorization:'Bearer '+token}})).status,403);
    const snapshot=(await (await get(path)).json()).result;
    assert.equal(snapshot.sessions.length,1);assert.equal(snapshot.sessions[0].sessionId,s.id);
    assert(!JSON.stringify(snapshot).includes('sshConfig'));assert(!JSON.stringify(snapshot).includes('valueFrom'));
    assert.equal((await get(path+'/sessions/'+other.id+'/commands')).status,404);
    const payload='<script>globalThis.injected=true</script> 한글';
    const command=`printf '%s' ${quote(payload)}; printf error >&2; sleep .2; false`;
    const admitted=await client.callTool({name:'run_command',arguments:{sessionId:s.id,command,clientRequestId:'command',waitMs:0,deadlineMs:10000,displayName:'검증 테스트'}});
    assert(!admitted.isError);const job=(admitted.structuredContent as {result:{id:string}}).result;
    assert.equal((await service.waitCommand('owner',job.id,10000)).command.exitCode,1);
    const commands=(await (await get(path+'/sessions/'+s.id+'/commands')).json()).result;
    assert.equal(commands[0].commandId,job.id);assert.equal(commands[0].exitCode,1);
    assert.equal(commands[0].displayName,'검증 테스트');
    assert.equal((await service.run('owner',s.id,command,'command',0,10000,'closed','검증 테스트')).id,job.id);
    await assert.rejects(service.run('owner',s.id,command,'command',0,10000,'closed','다른 이름'),{code:'REQUEST_CONFLICT'});
    assert(!('command' in commands[0]));assert(!('owner' in commands[0]));
    const output=(await (await get(path+'/commands/'+job.id+'/output?stream=stdout&cursor=0')).json()).result;
    assert.equal(Buffer.from(output.base64,'base64').toString(),payload);
    assert.equal((await get(path+'/commands/'+job.id+'/output?stream=stderr&cursor=-1')).status,400);
    assert.equal((await get(path+'/commands/'+job.id+'/output?stream=stdin')).status,400);
    const outside=await service.run('owner',other.id,'echo outside','outside',100,10000);await service.waitCommand('owner',outside.id,10000);
    assert.equal((await get(path+'/commands/'+outside.id+'/output?stream=stdout')).status,404);
    assert.equal((await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+token}})).status,405);
    service.store.put('view',{id:'v_foreign',owner:'bob',state:'active',updatedAt:Date.now(),sessionIds:[s.id],label:'foreign'});
    assert.equal((await get('/viewer-api/views/v_foreign')).status,404);
    f.config.targets.test.principals=[];assert.equal((await get(path)).status,403);f.config.targets.test.principals=['owner'];
    await service.closeSession('owner',s.id);await service.closeSession('owner',other.id);
    assert.equal((await (await get(path)).json()).result.sessions[0].state,'closed');
  }finally{await client.close();await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
});

test('saved browser views are idempotent, owner scoped, bounded and survive restart',{timeout:15000},async()=>{
  const f=await fixture();process.env.SHELL_MCP_TEST_TOKEN=token;let runtime=await startServer(f.config);
  try{
    const s=await runtime.service.open('owner','test','project','s');
    const a=runtime.service.createSessionView('owner',[s.id],'view','same');
    assert.equal(runtime.service.createSessionView('owner',[s.id],'view','same').viewId,a.viewId);
    assert.throws(()=>runtime.service.createSessionView('owner',[s.id],'different','same'),{code:'REQUEST_CONFLICT'});
    assert.throws(()=>runtime.service.createSessionView('bob',[s.id],'foreign','other'),{code:'NOT_FOUND'});
    for(let i=0;i<55;i++)runtime.service.store.put('command',{id:'c_test_'+i,owner:'owner',state:'completed',updatedAt:Date.now(),sessionId:s.id,exitCode:0});
    const history=runtime.service.viewCommands('owner',a.viewId,s.id);assert.equal(history.length,50);assert.equal(history[0].commandId,'c_test_54');
    await runtime.stop();runtime=await startServer(f.config);
    const view=runtime.service.sessionView('owner',a.viewId);assert.equal(view.sessions.length,1);assert.equal(view.sessions[0].state,'closed');
  }finally{await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
});

test('viewer static assets have strict policies and never embed credentials',{timeout:10000},async()=>{
  const f=await fixture();process.env.SHELL_MCP_TEST_TOKEN=token;const runtime=await startServer(f.config);
  const base=`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}`;
  try{
    for(const path of ['/sessions','/session-assets/app.js','/session-assets/style.css']){
      const response=await fetch(base+path);assert.equal(response.status,200);
      assert(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
      assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
      assert(!(await response.text()).includes(token));
    }
    assert.equal((await fetch(base+'/session-assets/no-such-file')).status,404);
  }finally{await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
});
