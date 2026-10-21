import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Authenticator } from './auth.js';
import type { ShellService } from './service.js';
import { Fault } from './core.js';

const outputQuery=z.object({stream:z.enum(['stdout','stderr']),cursor:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)});
export function sessionViewer(auth:Authenticator,service:ShellService){
  const router=express.Router();
  router.use((_req,res,next)=>{
    res.set({'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});next();
  });
  const directory=fileURLToPath(new URL('./viewer/',import.meta.url));
  router.get('/sessions',(_req,res)=>res.sendFile('index.html',{root:directory}));
  router.get('/session-assets/:file',(req,res)=>{
    if(!['app.js','style.css'].includes(req.params.file)){res.sendStatus(404);return;}
    res.sendFile(req.params.file,{root:directory});
  });
  const endpoint=(fn:(owner:string,req:Request)=>unknown)=>async(req:Request,res:Response)=>{
    try{
      const info=await auth.verify(req.get('authorization'));
      const owner=info.extra?.principal;if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');
      res.json({result:fn(owner,req)});
    }catch(error){
      const code=error instanceof Fault?error.code:error instanceof z.ZodError?'INVALID_ARGUMENT':'INTERNAL_ERROR';
      const status=code==='UNAUTHENTICATED'?401:code==='INSUFFICIENT_SCOPE'||code==='FORBIDDEN'?403:code==='NOT_FOUND'||code==='OUTPUT_EXPIRED'?404:code==='INVALID_ARGUMENT'||code==='INVALID_CURSOR'?400:500;
      if(status===401)res.set('WWW-Authenticate',auth.challenge());
      res.status(status).json({error:{code}});
    }
  };
  router.get('/viewer-api/views/:viewId',endpoint((owner,req)=>service.sessionView(owner,req.params.viewId as string)));
  router.get('/viewer-api/views/:viewId/sessions/:sessionId/commands',endpoint((owner,req)=>service.viewCommands(owner,req.params.viewId as string,req.params.sessionId as string)));
  router.get('/viewer-api/views/:viewId/commands/:commandId/output',endpoint((owner,req)=>{
    const q=outputQuery.parse(req.query);return service.viewOutput(owner,req.params.viewId as string,req.params.commandId as string,q.stream,q.cursor);
  }));
  // This namespace intentionally exposes GET only. It cannot execute or mutate SSH work.
  router.all('/viewer-api/{*path}',(_req,res)=>res.sendStatus(405));
  return router;
}
