import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createWriteStream, rmSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Authenticator } from './auth.js';
import type { ShellService } from './service.js';
import { Fault, hash } from './core.js';

const outputQuery=z.object({stream:z.enum(['stdout','stderr']),cursor:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)});
const transferQuery=z.object({path:z.string().min(1).max(4096),requestId:z.string().min(1).max(128).optional()});
const uploadCreateBody=z.object({path:z.string().min(1).max(4096),requestId:z.string().min(1).max(128),
  size:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),chunks:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256)}).strict();
const uploadChunkBytes=1048576;
interface BrowserUpload {key:string;owner:string;viewId:string;sessionId:string;path:string;requestId:string;size:number;chunks:string[];
  fingerprint:string;temporary:string;offset:number;touched:number;busy:boolean;state:'uploading'|'completed';result?:unknown;}
function statusFor(error:unknown){
  const code=error instanceof Fault?error.code:error instanceof z.ZodError?'INVALID_ARGUMENT':'INTERNAL_ERROR';
  const status=code==='UNAUTHENTICATED'?401:code==='INSUFFICIENT_SCOPE'||code==='FORBIDDEN'?403:
    code==='NOT_FOUND'||code==='OUTPUT_EXPIRED'?404:code==='FILE_TOO_LARGE'?413:code==='RESOURCE_LIMIT'?429:
    ['INVALID_ARGUMENT','INVALID_PATH','INVALID_CURSOR','INVALID_TRANSFER'].includes(code)?400:
    ['FILE_EXISTS','REQUEST_CONFLICT','TRANSFER_IN_PROGRESS','TRANSFER_UNKNOWN','TRANSFER_SEQUENCE','TRANSFER_CHECKSUM','TRANSFER_OFFSET','TRANSFER_INCOMPLETE','UPLOAD_CHECKSUM','SOURCE_CHANGED','TRANSFER_COMPLETED'].includes(code)?409:
    code==='TRANSFER_EXPIRED'?410:code==='TRANSFER_TIMEOUT'?408:500;
  return {code,status};
}
export function sessionViewer(auth:Authenticator,service:ShellService){
  const router=express.Router();
  router.use((_req,res,next)=>{
    expireBrowserUploads();
    res.set({'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});next();
  });
  const directory=fileURLToPath(new URL('./viewer/',import.meta.url));
  let activeUploads=0,reservedUploadBytes=0;
  const browserUploads=new Map<string,BrowserUpload>();
  const maxActiveUploads=Math.max(1,Math.min(4,service.config.limits.maxSessions));
  const maxStagedUploadBytes=service.config.limits.maxTransferBytes*2;
  const uploadKey=(owner:string,viewId:string,sessionId:string,requestId:string)=>JSON.stringify([owner,viewId,sessionId,requestId]);
  const discardBrowserUpload=(upload:BrowserUpload)=>{
    browserUploads.delete(upload.key);
    if(upload.temporary)rmSync(upload.temporary,{force:true});
    if(upload.state==='uploading')reservedUploadBytes=Math.max(0,reservedUploadBytes-upload.size);
  };
  const expireBrowserUploads=()=>{
    const cutoff=Date.now()-service.config.limits.transferTimeoutMs;
    for(const upload of browserUploads.values())if(!upload.busy&&upload.touched<cutoff)discardBrowserUpload(upload);
    const completed=[...browserUploads.values()].filter(upload=>upload.state==='completed').sort((a,b)=>a.touched-b.touched);
    while(browserUploads.size>128&&completed.length)discardBrowserUpload(completed.shift()!);
  };
  const verifyBrowserUploadPrefix=async(upload:BrowserUpload)=>{
    let handle:Awaited<ReturnType<typeof openFile>>;
    try{handle=await openFile(upload.temporary,fsConstants.O_RDWR|(fsConstants.O_NOFOLLOW??0)|(fsConstants.O_NONBLOCK??0));}
    catch{discardBrowserUpload(upload);throw new Fault('TRANSFER_EXPIRED','Upload staging file is missing');}
    try{
      const stat=await handle.stat();
      if(!stat.isFile()){discardBrowserUpload(upload);throw new Fault('TRANSFER_EXPIRED','Upload staging file is not regular');}
      if(stat.size>upload.offset){await handle.truncate(upload.offset);await handle.sync();}
      if(stat.size<upload.offset){await handle.truncate(0);await handle.sync();upload.offset=0;return;}
      let position=0,index=0;
      while(position<upload.offset){
        const length=Math.min(uploadChunkBytes,upload.offset-position),buffer=Buffer.allocUnsafe(length);let read=0;
        while(read<length){const result=await handle.read(buffer,read,length-read,position+read);if(result.bytesRead<=0)break;read+=result.bytesRead;}
        if(read!==length||createHash('sha256').update(buffer).digest('hex')!==upload.chunks[index]){
          await handle.truncate(0);await handle.sync();upload.offset=0;return;
        }
        position+=length;index++;
      }
    }finally{await handle.close();}
  };
  const uploadCapacity=()=>activeUploads+[...browserUploads.values()].filter(upload=>upload.state==='uploading').length;
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
  const chunkedUploadPath='/viewer-api/views/:viewId/sessions/:sessionId/uploads';
  router.post(chunkedUploadPath,express.json({limit:'32kb'}),async(req,res)=>{
    try{
      const info=await auth.verify(req.get('authorization'));
      const owner=info.extra?.principal;if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');
      const body=uploadCreateBody.parse(req.body),viewId=req.params.viewId as string,sessionId=req.params.sessionId as string;
      service.validateViewFilePath(owner,viewId,sessionId,body.path);
      if(body.size>service.config.limits.maxTransferBytes)throw new Fault('FILE_TOO_LARGE','Upload exceeds the configured transfer limit');
      if(body.chunks.length!==Math.ceil(body.size/uploadChunkBytes))throw new Fault('INVALID_ARGUMENT','Chunk manifest does not match the declared file size');
      expireBrowserUploads();
      const key=uploadKey(owner,viewId,sessionId,body.requestId),fingerprint=hash(JSON.stringify([body.path,body.size,body.chunks]));
      const previous=browserUploads.get(key);
      if(previous){
        if(previous.fingerprint!==fingerprint)throw new Fault('REQUEST_CONFLICT','Upload request ID was used with different file content');
        if(previous.busy)throw new Fault('TRANSFER_IN_PROGRESS','Another request is using this upload');
        if(previous.state==='uploading'){
          previous.busy=true;
          try{await verifyBrowserUploadPrefix(previous);}finally{previous.busy=false;}
        }
        previous.touched=Date.now();
        res.status(200).json({offset:previous.offset,size:previous.size,chunkBytes:uploadChunkBytes,
          complete:previous.state==='completed',...(previous.result?{result:previous.result}:{})});return;
      }
      if(uploadCapacity()>=maxActiveUploads)throw new Fault('RESOURCE_LIMIT','Too many active uploads');
      if(reservedUploadBytes+body.size>maxStagedUploadBytes)throw new Fault('RESOURCE_LIMIT','Upload staging capacity is full');
      const temporary=join(service.config.stateDir,'transfers',randomUUID()+'.upload');
      writeFileSync(temporary,new Uint8Array(),{flag:'wx',mode:0o600});
      const upload:BrowserUpload={key,owner,viewId,sessionId,path:body.path,requestId:body.requestId,size:body.size,chunks:body.chunks,
        fingerprint,temporary,offset:0,touched:Date.now(),busy:false,state:'uploading'};
      browserUploads.set(key,upload);reservedUploadBytes+=body.size;
      res.status(201).json({offset:0,size:upload.size,chunkBytes:uploadChunkBytes,complete:false});
    }catch(error){
      if(res.destroyed)return;
      const {code,status}=statusFor(error);if(status===401)res.set('WWW-Authenticate',auth.challenge());res.status(status).json({error:{code}});
    }
  });
  router.patch(chunkedUploadPath,async(req,res)=>{
    let upload:BrowserUpload|undefined,handle:Awaited<ReturnType<typeof openFile>>|undefined,chunkTimer:NodeJS.Timeout|undefined;
    try{
      const info=await auth.verify(req.get('authorization'));
      const owner=info.extra?.principal;if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');
      const q=transferQuery.parse(req.query),viewId=req.params.viewId as string,sessionId=req.params.sessionId as string;
      if(!q.requestId)throw new Fault('INVALID_ARGUMENT','Upload requestId is required');
      service.validateViewFilePath(owner,viewId,sessionId,q.path);expireBrowserUploads();
      upload=browserUploads.get(uploadKey(owner,viewId,sessionId,q.requestId));
      if(!upload)throw new Fault('TRANSFER_EXPIRED','Upload is missing or expired');
      if(upload.path!==q.path)throw new Fault('REQUEST_CONFLICT','Upload path differs from its creation request');
      if(upload.state!=='uploading')throw new Fault('TRANSFER_IN_PROGRESS','Upload is already complete');
      if(upload.busy)throw new Fault('TRANSFER_IN_PROGRESS','Another chunk is being written for this upload');
      if(!/^application\/offset\+octet-stream(?:\s*;|$)/i.test(req.get('content-type')||''))throw new Fault('INVALID_ARGUMENT','Use application/offset+octet-stream');
      const rawOffset=req.get('upload-offset');
      if(!rawOffset||!/^(0|[1-9][0-9]*)$/.test(rawOffset))throw new Fault('INVALID_ARGUMENT','Upload-Offset must be a non-negative integer');
      const offset=Number(rawOffset);
      if(!Number.isSafeInteger(offset))throw new Fault('INVALID_ARGUMENT','Invalid Upload-Offset');
      if(offset!==upload.offset){res.set('Upload-Offset',String(upload.offset)).status(409).json({error:{code:'TRANSFER_OFFSET'}});return;}
      if(offset>=upload.size||offset%uploadChunkBytes!==0)throw new Fault('INVALID_ARGUMENT','Upload offset is outside the next chunk boundary');
      const chunkIndex=offset/uploadChunkBytes,expectedBytes=Math.min(uploadChunkBytes,upload.size-offset);
      const contentLength=req.get('content-length');
      if(contentLength!==undefined&&Number(contentLength)!==expectedBytes)throw new Fault('INVALID_ARGUMENT','Chunk length does not match the expected size');
      upload.busy=true;upload.touched=Date.now();
      handle=await openFile(upload.temporary,fsConstants.O_RDWR|(fsConstants.O_NOFOLLOW??0)|(fsConstants.O_NONBLOCK??0));
      const stat=await handle.stat();
      if(!stat.isFile())throw new Fault('INVALID_TRANSFER','Upload staging file is not regular');
      if(stat.size<upload.offset){await handle.truncate(0);await handle.sync();upload.offset=0;throw new Fault('TRANSFER_OFFSET','Upload staging is shorter than its confirmed offset');}
      if(stat.size>upload.offset){await handle.truncate(upload.offset);await handle.sync();throw new Fault('TRANSFER_OFFSET','Upload staging has an unconfirmed tail');}
      const digest=createHash('sha256');let bytes=0;
      chunkTimer=setTimeout(()=>req.destroy(new Fault('TRANSFER_TIMEOUT','Upload chunk timed out')),service.config.limits.transferTimeoutMs);chunkTimer.unref();
      for await(const part of req){
        const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
        if(bytes+chunk.length>expectedBytes)throw new Fault('INVALID_ARGUMENT','Chunk exceeds the expected size');
        digest.update(chunk);let written=0;
        while(written<chunk.length){
          const result=await handle.write(chunk,written,chunk.length-written,offset+bytes+written);
          if(result.bytesWritten<=0)throw new Fault('UPLOAD_WRITE_FAILED','Could not write the upload chunk');
          written+=result.bytesWritten;
        }
        bytes+=chunk.length;
      }
      if(bytes!==expectedBytes)throw new Fault('TRANSFER_INCOMPLETE','Chunk ended before its declared size');
      if(digest.digest('hex')!==upload.chunks[chunkIndex])throw new Fault('UPLOAD_CHECKSUM','Chunk checksum does not match the selected file');
      await handle.sync();upload.offset+=bytes;upload.touched=Date.now();
      res.set('Upload-Offset',String(upload.offset)).status(204).end();
    }catch(error){
      if(handle&&upload){await handle.truncate(upload.offset).catch(()=>{});await handle.sync().catch(()=>{});}
      if(res.destroyed||req.aborted)return;
      const {code,status}=statusFor(error);if(status===401)res.set('WWW-Authenticate',auth.challenge());
      if(upload)res.set('Upload-Offset',String(upload.offset));res.status(status).json({error:{code}});
    }finally{
      if(chunkTimer)clearTimeout(chunkTimer);
      if(handle)await handle.close().catch(()=>{});
      if(upload){upload.busy=false;upload.touched=Date.now();}
    }
  });
  router.post(chunkedUploadPath+'/complete',async(req,res)=>{
    let upload:BrowserUpload|undefined;
    try{
      const info=await auth.verify(req.get('authorization'));
      const owner=info.extra?.principal;if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');
      const q=transferQuery.parse(req.query),viewId=req.params.viewId as string,sessionId=req.params.sessionId as string;
      if(!q.requestId)throw new Fault('INVALID_ARGUMENT','Upload requestId is required');
      service.validateViewFilePath(owner,viewId,sessionId,q.path);expireBrowserUploads();
      upload=browserUploads.get(uploadKey(owner,viewId,sessionId,q.requestId));
      if(!upload)throw new Fault('TRANSFER_EXPIRED','Upload is missing or expired');
      if(upload.path!==q.path)throw new Fault('REQUEST_CONFLICT','Upload path differs from its creation request');
      if(upload.state==='completed'){res.json({result:upload.result});return;}
      if(upload.busy)throw new Fault('TRANSFER_IN_PROGRESS','Another request is using this upload');
      upload.busy=true;upload.touched=Date.now();
      await verifyBrowserUploadPrefix(upload);
      if(upload.offset!==upload.size)throw new Fault('TRANSFER_INCOMPLETE','Upload has not reached its declared size');
      const result=await service.uploadViewFile(owner,viewId,sessionId,upload.path,upload.temporary,upload.requestId);
      upload.result=result;upload.state='completed';upload.touched=Date.now();
      reservedUploadBytes=Math.max(0,reservedUploadBytes-upload.size);rmSync(upload.temporary,{force:true});upload.temporary='';
      res.json({result});
    }catch(error){
      if(upload&&error instanceof Fault&&['FILE_EXISTS','INVALID_PATH','FILE_TOO_LARGE','REQUEST_CONFLICT','INVALID_ARGUMENT'].includes(error.code))discardBrowserUpload(upload);
      if(res.destroyed||req.aborted)return;
      const {code,status}=statusFor(error);if(status===401)res.set('WWW-Authenticate',auth.challenge());res.status(status).json({error:{code}});
    }finally{if(upload){upload.busy=false;upload.touched=Date.now();}}
  });
  router.delete(chunkedUploadPath,async(req,res)=>{
    try{
      const info=await auth.verify(req.get('authorization'));
      const owner=info.extra?.principal;if(typeof owner!=='string')throw new Fault('UNAUTHENTICATED','Authentication required');
      const q=transferQuery.parse(req.query),viewId=req.params.viewId as string,sessionId=req.params.sessionId as string;
      if(!q.requestId)throw new Fault('INVALID_ARGUMENT','Upload requestId is required');
      service.validateViewFilePath(owner,viewId,sessionId,q.path);expireBrowserUploads();
      const upload=browserUploads.get(uploadKey(owner,viewId,sessionId,q.requestId));
      if(!upload){res.status(204).end();return;}
      if(upload.path!==q.path)throw new Fault('REQUEST_CONFLICT','Upload path differs from its creation request');
      if(upload.busy)throw new Fault('TRANSFER_IN_PROGRESS','Another request is using this upload');
      if(upload.state==='completed')throw new Fault('TRANSFER_COMPLETED','Completed uploads cannot be cancelled');
      discardBrowserUpload(upload);res.status(204).end();
    }catch(error){
      if(res.destroyed)return;
      const {code,status}=statusFor(error);if(status===401)res.set('WWW-Authenticate',auth.challenge());res.status(status).json({error:{code}});
    }
  });
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
      if(uploadCapacity()>=maxActiveUploads)throw new Fault('RESOURCE_LIMIT','Too many active uploads');
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
  router.use((error:unknown,_req:Request,res:Response,next:express.NextFunction)=>{
    if(res.headersSent){next(error);return;}
    const typed=error as {type?:string};
    const code=typed?.type==='entity.too.large'?'FILE_TOO_LARGE':typed?.type==='entity.parse.failed'?'INVALID_ARGUMENT':undefined;
    const {code:statusCode,status}=code?{code,status:code==='FILE_TOO_LARGE'?413:400}:statusFor(error);
    res.status(status).json({error:{code:statusCode}});
  });
  router.all('/viewer-api/{*path}',(_req,res)=>res.sendStatus(405));
  return router;
}
