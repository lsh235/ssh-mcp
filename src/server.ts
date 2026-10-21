import express from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Server } from 'node:http';
import type { Config } from './config.js';
import { Authenticator } from './auth.js';
import { ShellService } from './service.js';
import { createTools } from './tools.js';
import { Fault } from './core.js';
import { sessionViewer } from './viewer.js';

export function createApp(config:Config) {
  const auth=new Authenticator(config), service=new ShellService(config), app=express();
  app.disable('x-powered-by');
  const handler=createMcpHandler(ctx=>{
    const owner=ctx.authInfo?.extra?.principal;
    if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication missing');
    return createTools(service,owner);
  },{legacy:'stateless',responseMode:'auto',maxRequestBodySize:524288,onerror:()=>{ /* Never log request bodies or tokens. */ }});
  const mcp=toNodeHandler(handler,{maxRequestBodySize:524288});
  app.use((req,res,next)=>{
    if(!config.allowedHosts.includes(req.hostname)) {res.status(403).json({error:'HOST_FORBIDDEN'});return;}
    const origin=req.get('origin');
    const viewerPath=req.path==='/sessions'||req.path.startsWith('/viewer-api/')||req.path.startsWith('/session-assets/');
    const viewerOrigin=viewerPath&&origin===new URL(config.publicUrl).origin;
    if(origin&&!viewerOrigin&&!config.allowedOrigins.includes(origin)){res.status(403).json({error:'ORIGIN_FORBIDDEN'});return;}
    res.set('Cache-Control','no-store');next();
  });
  app.use(sessionViewer(auth,service));
  app.get('/health',(_req,res)=>res.json({status:'ok',version:'0.4.0'}));
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'])app.get(path,(_req,res)=>{
    if(config.auth.mode!=='oauth'){res.sendStatus(404);return;}res.json(auth.metadata());
  });
  app.all('/mcp',async(req,res)=>{
    try {
      const info=await auth.verify(req.get('authorization'));
      Object.assign(req,{auth:info});
      await mcp(req,res);
    }catch(error){
      if(res.headersSent)return;
      const forbidden=error instanceof Fault&&error.code==='INSUFFICIENT_SCOPE';
      res.set('WWW-Authenticate',auth.challenge()).status(forbidden?403:401).json({error:forbidden?'INSUFFICIENT_SCOPE':'UNAUTHENTICATED'});
    }
  });
  app.use((_req,res)=>res.sendStatus(404));
  return {app,service,close:async()=>{await handler.close();await service.shutdown();}};
}
export async function startServer(config:Config) {
  const runtime=createApp(config);
  const server=await new Promise<Server>((resolve,reject)=>{const s=runtime.app.listen(config.port,config.host,()=>resolve(s));s.once('error',reject);});
  return {...runtime,server,stop:async()=>{
    server.closeIdleConnections();
    const stopped=new Promise<void>(resolve=>server.close(()=>resolve()));
    await runtime.close();server.closeAllConnections();await stopped;
  }};
}
