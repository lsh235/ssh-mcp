import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ShellService } from '../src/service.js';
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
    const binary=Buffer.alloc(2*1024*1024+37);for(let i=0;i<binary.length;i++)binary[i]=(i*31+17)%256;
    const localUpload=join(f.dir,'browser-transfer.bin');writeFileSync(localUpload,binary);
    const fileUrl=(sessionId:string,remotePath:string,requestId?:string)=>{
      const query=new URLSearchParams({path:remotePath});if(requestId)query.set('requestId',requestId);
      return path+'/sessions/'+encodeURIComponent(sessionId)+'/files?'+query;
    };
    assert.equal((await get(fileUrl(s.id,'browser-transfer.bin'),false)).status,401);
    assert.equal((await fetch(base+fileUrl(other.id,'denied.bin','outside-view'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:Buffer.from('denied')
    })).status,404);
    assert.equal((await fetch(base+fileUrl(s.id,'denied-origin.bin','bad-origin'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream',Origin:'https://untrusted.example'},body:Buffer.from('denied')
    })).status,403);
    const upload=await fetch(base+fileUrl(s.id,'browser-transfer.bin','browser-upload-1'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:readFileSync(localUpload)
    });
    assert.equal(upload.status,200,JSON.stringify(await upload.clone().json()));
    const uploadResult=(await upload.json()).result;assert.equal(uploadResult.state,'completed');assert.equal(uploadResult.bytes,binary.length);
    const retry=await fetch(base+fileUrl(s.id,'browser-transfer.bin','browser-upload-1'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:binary
    });assert.equal(retry.status,200);assert.equal((await retry.json()).result.transferId,uploadResult.transferId);
    const conflict=await fetch(base+fileUrl(s.id,'browser-transfer.bin','browser-upload-1'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:Buffer.from('different body')
    });assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'REQUEST_CONFLICT');
    const download=await get(fileUrl(s.id,'browser-transfer.bin'));assert.equal(download.status,200);
    assert.equal(download.headers.get('x-content-sha256'),uploadResult.sha256);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),binary);
    const oldLimit=f.config.limits.maxTransferBytes;f.config.limits.maxTransferBytes=1024;
    assert.equal((await get(fileUrl(s.id,'browser-transfer.bin'))).status,413);
    const tooLarge=await fetch(base+fileUrl(s.id,'too-large.bin','too-large'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:binary
    });assert.equal(tooLarge.status,413);f.config.limits.maxTransferBytes=oldLimit;
    const existing=await fetch(base+fileUrl(s.id,'browser-transfer.bin','browser-upload-overwrite'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:Buffer.from('replacement')
    });assert.equal(existing.status,409);assert.equal((await existing.json()).error.code,'FILE_EXISTS');
    assert.deepEqual(readFileSync(join(f.root,'browser-transfer.bin')),binary);
    assert.equal((await get(fileUrl(other.id,'browser-transfer.bin'))).status,404);
    const emptyUpload=await fetch(base+fileUrl(s.id,'empty.bin','empty-upload'),{
      method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:new Uint8Array()
    });assert.equal(emptyUpload.status,200);assert.equal((await emptyUpload.json()).result.bytes,0);
    const emptyDownload=await get(fileUrl(s.id,'empty.bin'));assert.equal(emptyDownload.status,200);assert.equal((await emptyDownload.arrayBuffer()).byteLength,0);
    symlinkSync('/etc/hostname',join(f.root,'browser-transfer-link'));
    assert.equal((await get(fileUrl(s.id,'browser-transfer-link'))).status,400);
    assert.equal((await fetch(base+fileUrl(s.id,'browser-transfer.bin','bad-type'),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:'x'})).status,400);
    assert.deepEqual(readdirSync(join(f.config.stateDir,'transfers')),[]);
    const audit=readFileSync(join(f.config.stateDir,'audit.jsonl'),'utf8');
    assert(audit.includes('file_upload_requested'));assert(audit.includes('file_upload'));
    assert(!audit.includes('browser-transfer.bin'));assert(!audit.includes(binary.toString('base64').slice(0,64)));
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

test('browser uploads resume confirmed SSH prefixes and reset a corrupt remote prefix',{timeout:45000},async()=>{
  const f=await fixture(),service=new ShellService(f.config);
  try{
    const session=await service.open('owner','test','project','resume-upload-session');
    service.createSessionView('owner',[session.id],'upload resume','resume-upload-view');
    type TestSSH={helper:(args:Record<string,unknown>,timeout?:number)=>Promise<unknown>};
    const ssh=(service as unknown as {runtimes:Map<string,{ssh:TestSSH}>}).runtimes.get(session.id)!.ssh;
    const original=ssh.helper.bind(ssh),sequences:number[]=[];let loseNextFirstChunk=true;
    ssh.helper=async(args,timeout)=>{
      if(args.op==='upload_chunk')sequences.push(Number(args.sequence));
      const result=await original(args,timeout);
      if(args.op==='upload_chunk'&&args.sequence===0&&loseNextFirstChunk){loseNextFirstChunk=false;throw new Error('fixture: lost chunk acknowledgement after remote fsync');}
      return result;
    };
    const payload=Buffer.alloc(2*1024*1024+37);for(let i=0;i<payload.length;i++)payload[i]=(i*31+17)%256;
    const source=join(f.dir,'resume.bin');writeFileSync(source,payload);
    await assert.rejects(service.uploadViewFile('owner',service.store.list('view','owner')[0].id,session.id,'resume.bin',source,'resume-ok'),{code:'TRANSFER_UNKNOWN'});
    const row=service.store.list('transfer','owner').find(item=>item.state==='unknown')!;
    const unconfirmed=join(f.root,`.shell-mcp-${row.id}.part`);writeFileSync(unconfirmed,Buffer.concat([readFileSync(unconfirmed),Buffer.from('unconfirmed tail')]));
    assert.deepEqual(sequences,[0]);
    const resumed=await service.uploadViewFile('owner',service.store.list('view','owner')[0].id,session.id,'resume.bin',source,'resume-ok');
    assert.equal(resumed.state,'completed');assert.deepEqual(sequences,[0,1,2]);
    assert.deepEqual(readFileSync(join(f.root,'resume.bin')),payload);

    const corruptSource=join(f.dir,'resume-corrupt.bin');writeFileSync(corruptSource,payload);sequences.length=0;loseNextFirstChunk=true;
    await assert.rejects(service.uploadViewFile('owner',service.store.list('view','owner')[0].id,session.id,'resume-corrupt.bin',corruptSource,'resume-corrupt'),{code:'TRANSFER_UNKNOWN'});
    const corruptRow=service.store.list('transfer','owner').find(item=>item.state==='unknown')!;
    const partial=join(f.root,`.shell-mcp-${corruptRow.id}.part`),corrupt=readFileSync(partial);corrupt[0]^=0xff;writeFileSync(partial,corrupt);
    assert.deepEqual(sequences,[0]);
    const recovered=await service.uploadViewFile('owner',service.store.list('view','owner')[0].id,session.id,'resume-corrupt.bin',corruptSource,'resume-corrupt');
    assert.equal(recovered.state,'completed');assert.deepEqual(sequences,[0,0,1,2]);
    assert.deepEqual(readFileSync(join(f.root,'resume-corrupt.bin')),payload);

    const restartSource=join(f.dir,'resume-restart.bin');writeFileSync(restartSource,payload);sequences.length=0;loseNextFirstChunk=true;
    await assert.rejects(service.uploadViewFile('owner',service.store.list('view','owner')[0].id,session.id,'resume-restart.bin',restartSource,'resume-restart'),{code:'TRANSFER_UNKNOWN'});
    const restartRow=service.store.list('transfer','owner').find(item=>item.state==='unknown')!;
    service.store.put('transfer',{...restartRow,reason:'SERVER_RESTART'});
    await assert.rejects(service.uploadViewFile('owner',service.store.list('view','owner')[0].id,session.id,'resume-restart.bin',restartSource,'resume-restart'),{code:'TRANSFER_UNKNOWN'});
    assert.deepEqual(sequences,[0],'a transfer marked as recovered from server restart is never replayed');
    await service.closeSession('owner',session.id);
  }finally{await service.shutdown();await f.close();}
});

test('chunked browser uploads resume host staging, reject offsets and verify each chunk',{timeout:45000},async()=>{
  const f=await fixture();process.env.SHELL_MCP_TEST_TOKEN=token;const runtime=await startServer(f.config),service=runtime.service;
  const base=`http://127.0.0.1:${(runtime.server.address() as {port:number}).port}`;f.config.publicUrl=base+'/mcp';
  try{
    const session=await service.open('owner','test','project','chunked-upload-session');
    const view=service.createSessionView('owner',[session.id],'chunk upload','chunked-upload-view');
    const uploadUrl=base+'/viewer-api/views/'+view.viewId+'/sessions/'+session.id+'/uploads';
    const headers={Authorization:'Bearer '+token};
    const bytes=Buffer.alloc(2*1048576+19);for(let i=0;i<bytes.length;i++)bytes[i]=(i*43+29)%256;
    const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=1048576)chunks.push(createHash('sha256').update(bytes.subarray(offset,Math.min(bytes.length,offset+1048576))).digest('hex'));
    const create=(requestId:string,path:string,chunkHashes=chunks,auth=true)=>fetch(uploadUrl,{method:'POST',headers:{...(auth?headers:{}),'Content-Type':'application/json'},body:JSON.stringify({path,requestId,size:bytes.length,chunks:chunkHashes})});
    assert.equal((await create('chunked','chunked.bin',chunks,false)).status,401);
    const initialized=await create('chunked','chunked.bin');assert.equal(initialized.status,201);assert.equal((await initialized.json()).offset,0);
    const changed=[...chunks];changed[0]='0'.repeat(64);const conflict=await create('chunked','chunked.bin',changed);
    assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'REQUEST_CONFLICT');
    const badChunk=Buffer.from(bytes.subarray(0,1048576));badChunk[0]^=0xff;
    const patch=(offset:number,body:Buffer)=>fetch(uploadUrl+'?'+new URLSearchParams({path:'chunked.bin',requestId:'chunked'}),{
      method:'PATCH',headers:{...headers,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset)},body
    });
    const bad=await patch(0,badChunk);assert.equal(bad.status,409);assert.equal((await bad.json()).error.code,'UPLOAD_CHECKSUM');
    assert.equal((await (await create('chunked','chunked.bin')).json()).offset,0,'a bad chunk must not advance the confirmed offset');
    const first=await patch(0,bytes.subarray(0,1048576));assert.equal(first.status,204);assert.equal(first.headers.get('upload-offset'),'1048576');
    const resumed=await create('chunked','chunked.bin');assert.equal(resumed.status,200);assert.equal((await resumed.json()).offset,1048576);
    const stale=await patch(0,bytes.subarray(0,1048576));assert.equal(stale.status,409);assert.equal(stale.headers.get('upload-offset'),'1048576');
    const staged=join(f.config.stateDir,'transfers',readdirSync(join(f.config.stateDir,'transfers'))[0]);
    const damaged=readFileSync(staged);damaged[0]^=0xff;writeFileSync(staged,damaged);
    const reconciled=await create('chunked','chunked.bin');assert.equal(reconciled.status,200);assert.equal((await reconciled.json()).offset,0,'a same-length corrupt confirmed prefix must restart from zero');
    assert.equal((await patch(0,bytes.subarray(0,1048576))).status,204);
    writeFileSync(staged,bytes.subarray(0,123));
    const shortened=await patch(1048576,bytes.subarray(1048576,2*1048576));assert.equal(shortened.status,409);assert.equal(shortened.headers.get('upload-offset'),'0','a missing confirmed prefix resets the server offset');
    const reset=await create('chunked','chunked.bin');assert.equal(reset.status,200);assert.equal((await reset.json()).offset,0);
    assert.equal((await patch(0,bytes.subarray(0,1048576))).status,204);
    const incomplete=await fetch(uploadUrl+'/complete?'+new URLSearchParams({path:'chunked.bin',requestId:'chunked'}),{method:'POST',headers});
    assert.equal(incomplete.status,409);assert.equal((await incomplete.json()).error.code,'TRANSFER_INCOMPLETE');
    const middle=await patch(1048576,bytes.subarray(1048576,2*1048576));assert.equal(middle.status,204);assert.equal(middle.headers.get('upload-offset'),String(2*1048576));
    const tail=await patch(2*1048576,bytes.subarray(2*1048576));assert.equal(tail.status,204);assert.equal(tail.headers.get('upload-offset'),String(bytes.length));
    const completeUrl=uploadUrl+'/complete?'+new URLSearchParams({path:'chunked.bin',requestId:'chunked'});
    const completed=await fetch(completeUrl,{method:'POST',headers});assert.equal(completed.status,200);
    const result=(await completed.json()).result;assert.equal(result.state,'completed');assert.equal(result.bytes,bytes.length);
    assert.deepEqual(readFileSync(join(f.root,'chunked.bin')),bytes);
    const repeated=await create('chunked','chunked.bin');assert.equal(repeated.status,200);assert.equal((await repeated.json()).complete,true);
    const completedAgain=await fetch(completeUrl,{method:'POST',headers});assert.equal((await completedAgain.json()).result.transferId,result.transferId);
    const completedDelete=await fetch(uploadUrl+'?'+new URLSearchParams({path:'chunked.bin',requestId:'chunked'}),{method:'DELETE',headers});
    assert.equal(completedDelete.status,409);assert.equal((await completedDelete.json()).error.code,'TRANSFER_COMPLETED');
    assert.equal((await create('cancel-upload','cancel.bin')).status,201);
    const cancelQuery=new URLSearchParams({path:'cancel.bin',requestId:'cancel-upload'});
    const cancelPatch=await fetch(uploadUrl+'?'+cancelQuery,{method:'PATCH',headers:{...headers,'Content-Type':'application/offset+octet-stream','Upload-Offset':'0'},body:bytes.subarray(0,1048576)});
    assert.equal(cancelPatch.status,204);
    const cancelUrl=uploadUrl+'?'+cancelQuery;
    assert.equal((await fetch(cancelUrl,{method:'DELETE',headers:{}})).status,401);
    assert.equal((await fetch(cancelUrl,{method:'DELETE',headers})).status,204);
    assert.equal((await fetch(cancelUrl,{method:'DELETE',headers})).status,204,'cancellation is safe to retry after an uncertain response');
    const afterCancel=await create('cancel-upload','cancel.bin');assert.equal(afterCancel.status,201);assert.equal((await afterCancel.json()).offset,0);
    assert.equal((await fetch(cancelUrl,{method:'DELETE',headers})).status,204);
    const cancelledComplete=await fetch(uploadUrl+'/complete?'+new URLSearchParams({path:'cancel.bin',requestId:'cancel-upload'}),{method:'POST',headers});
    assert.equal(cancelledComplete.status,410,'a deleted staging upload cannot be completed');
    assert.deepEqual(readdirSync(join(f.config.stateDir,'transfers')),[]);
    await service.closeSession('owner',session.id);
  }finally{await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
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
    await runtime.stop();writeFileSync(join(f.config.stateDir,'transfers','interrupted.upload'),'private fixture bytes',{mode:0o600});runtime=await startServer(f.config);
    assert.deepEqual(readdirSync(join(f.config.stateDir,'transfers')),[]);
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
    const html=await (await fetch(base+'/sessions')).text(),js=await (await fetch(base+'/session-assets/app.js')).text();
    assert(html.includes('type="file"'));assert(html.includes('원격 파일 전송'));assert(js.includes('XMLHttpRequest'));
    assert(!js.includes('localStorage'));assert(js.includes('sessionStorage.getItem'));assert(js.includes('sessionStorage.setItem'));
    assert(js.includes("xhr.open('PATCH'"));assert(js.includes("'/uploads'"));
    assert(js.includes("method:'DELETE'"));assert(html.includes('id="cancel-upload"'));
    assert(!js.includes("sessionStorage.setItem('token'"));assert(!js.includes('sessionStorage.setItem("token"'));
    assert.equal((await fetch(base+'/session-assets/no-such-file')).status,404);
  }finally{await runtime.stop();await f.close();delete process.env.SHELL_MCP_TEST_TOKEN;}
});
