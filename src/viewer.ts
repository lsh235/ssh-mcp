import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Authenticator } from './auth.js';
import type { ShellService } from './service.js';
import { Fault } from './core.js';

const outputQuery=z.object({stream:z.enum(['stdout','stderr']),cursor:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)});
const transferQuery=z.object({path:z.string().min(1).max(4096),requestId:z.string().min(1).max(128).optional()});
function statusFor(error:unknown){
  const code=error instanceof Fault?error.code:error instanceof z.ZodError?'INVALID_ARGUMENT':'INTERNAL_ERROR';
  const status=code==='UNAUTHENTICATED'?401:code==='INSUFFICIENT_SCOPE'||code==='FORBIDDEN'?403:
    code==='NOT_FOUND'||code==='OUTPUT_EXPIRED'?404:code==='FILE_TOO_LARGE'?413:code==='RESOURCE_LIMIT'?429:
    ['INVALID_ARGUMENT','INVALID_PATH','INVALID_CURSOR','INVALID_TRANSFER'].includes(code)?400:
    ['FILE_EXISTS','REQUEST_CONFLICT','TRANSFER_IN_PROGRESS','TRANSFER_UNKNOWN','TRANSFER_SEQUENCE','TRANSFER_CHECKSUM','SOURCE_CHANGED'].includes(code)?409:500;
  return {code,status};
}
export function sessionViewer(auth:Authenticator,service:ShellService){
  const router=express.Router();
  router.use((_req,res,next)=>{
    res.set({'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});next();
  });
  const directory=fileURLToPath(new URL('./viewer/',import.meta.url));
  let activeUploads=0,reservedUploadBytes=0;
  const maxActiveUploads=Math.max(1,Math.min(4,service.config.limits.maxSessions));
  const maxStagedUploadBytes=service.config.limits.maxTransferBytes*2;
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
  router.put('/viewer-api/views/:viewId/sessions/:sessionId/files',async(req,res)=>{
    let temporary='',reservation=0,reserved=false;
    try{
      const info=await auth.verify(req.get('authorization'));
      const owner=info.extra?.principal;if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');
      const q=transferQuery.parse(req.query);
      service.validateViewFilePath(owner,req.params.viewId as string,req.params.sessionId as string,q.path);
      if(!q.requestId)throw new Fault('INVALID_ARGUMENT','Upload requestId is required');
      if(!/^application\/octet-stream(?:\s*;|$)/i.test(req.get('content-type')||''))throw new Fault('INVALID_ARGUMENT','Use application/octet-stream');
      const contentLength=req.get('content-length');
      if(contentLength!==undefined){
        const size=Number(contentLength);
        if(!Number.isSafeInteger(size)||size<0)throw new Fault('INVALID_ARGUMENT','Invalid Content-Length');
        if(size>service.config.limits.maxTransferBytes)throw new Fault('FILE_TOO_LARGE','Upload exceeds the configured transfer limit');
      }
      if(activeUploads>=maxActiveUploads)throw new Fault('RESOURCE_LIMIT','Too many active uploads');
      reservation=contentLength===undefined?service.config.limits.maxTransferBytes:Number(contentLength);
      if(reservedUploadBytes+reservation>maxStagedUploadBytes)throw new Fault('RESOURCE_LIMIT','Upload staging capacity is full');
      activeUploads++;reservedUploadBytes+=reservation;reserved=true;
      temporary=join(service.config.stateDir,'transfers',randomUUID()+'.upload');
      let bytes=0;
      const limiter=new Transform({transform(chunk:Buffer,_encoding,callback){
        bytes+=chunk.length;
        if(bytes>service.config.limits.maxTransferBytes){callback(new Fault('FILE_TOO_LARGE','Upload exceeds the configured transfer limit'));return;}
        callback(null,chunk);
      }});
      const disconnected=new AbortController();
      const onAborted=()=>disconnected.abort(new Error('Upload client disconnected'));
      req.once('aborted',onAborted);
      try{
        await pipeline(req,limiter,createWriteStream(temporary,{flags:'wx',mode:0o600}),
          {signal:AbortSignal.any([disconnected.signal,AbortSignal.timeout(service.config.limits.transferTimeoutMs)])});
      }finally{req.off('aborted',onAborted);}
      const result=await service.uploadViewFile(owner,req.params.viewId as string,req.params.sessionId as string,q.path,temporary,q.requestId,disconnected.signal);
      res.json({result});
    }catch(error){
      if(res.destroyed||req.aborted)return;
      const {code,status}=statusFor(error);if(status===401)res.set('WWW-Authenticate',auth.challenge());res.status(status).json({error:{code}});
    }finally{
      if(temporary)rmSync(temporary,{force:true});
      if(reserved){activeUploads--;reservedUploadBytes-=reservation;}
    }
  });
  router.get('/viewer-api/views/:viewId/sessions/:sessionId/files',async(req,res)=>{
    let owner='',transferId='';const controller=new AbortController();let complete=false;
    const abort=()=>controller.abort(new Error('Download client disconnected'));
    const onClose=()=>{if(!res.writableEnded)abort();};
    req.once('aborted',abort);res.once('close',onClose);
    try{
      const info=await auth.verify(req.get('authorization'));
      const principal=info.extra?.principal;if(typeof principal!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');owner=principal;
      const q=transferQuery.parse(req.query);
      const transfer=await service.prepareViewDownload(owner,req.params.viewId as string,req.params.sessionId as string,q.path);
      transferId=transfer.transferId;
      const encoded=encodeURIComponent(transfer.filename).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
      res.status(200).set({
        'Content-Type':'application/octet-stream','Content-Length':String(transfer.bytes),
        'Content-Disposition':`attachment; filename*=UTF-8''${encoded}`,
        'X-Content-SHA256':transfer.sha256,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'
      });
      const digest=createHash('sha256');let offset=0;
      while(offset<transfer.bytes){
        if(controller.signal.aborted)throw controller.signal.reason;
        const chunk=await service.readViewDownloadChunk(owner,req.params.viewId as string,req.params.sessionId as string,transferId,offset);
        if(!chunk.length)throw new Fault('INVALID_REMOTE_RESULT','Remote download ended before the declared size');
        offset+=chunk.length;digest.update(chunk);
        if(!res.write(chunk))await new Promise<void>((resolve,reject)=>{
          const onDrain=()=>{cleanup();resolve();},onError=(error:Error)=>{cleanup();reject(error);},onClose=()=>{cleanup();reject(new Error('Download client disconnected'));};
          const cleanup=()=>{res.off('drain',onDrain);res.off('error',onError);res.off('close',onClose);};
          res.once('drain',onDrain);res.once('error',onError);res.once('close',onClose);
        });
      }
      if(digest.digest('hex')!==transfer.sha256)throw new Fault('TRANSFER_CHECKSUM','Downloaded bytes failed checksum verification');
      await new Promise<void>((resolve,reject)=>{
        const onFinish=()=>{cleanup();resolve();},onClose=()=>{cleanup();reject(new Error('Download client disconnected'));};
        const cleanup=()=>{res.off('finish',onFinish);res.off('close',onClose);};
        res.once('finish',onFinish);res.once('close',onClose);res.end();
      });
      complete=true;
    }catch(error){
      if(req.aborted||res.destroyed)return;
      if(!res.headersSent){const {code,status}=statusFor(error);if(status===401)res.set('WWW-Authenticate',auth.challenge());res.status(status).json({error:{code}});}
      else res.destroy();
    }finally{
      req.off('aborted',abort);res.off('close',onClose);
      if(transferId)await service.closeViewDownload(owner,req.params.viewId as string,req.params.sessionId as string,transferId,complete).catch(()=>{});
    }
  });
  // This namespace only exposes read APIs and explicit, authenticated file transfers.
  router.all('/viewer-api/{*path}',(_req,res)=>res.sendStatus(405));
  return router;
}
