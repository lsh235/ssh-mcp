import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authenticator } from '../src/auth.js';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/storage.js';
test('OAuth validates audience, expiry, subject and scopes against signed tokens',async()=>{
  const config=parseConfig({publicUrl:'https://mcp.example.com/mcp',auth:{mode:'oauth',issuer:'https://id.example.com',audience:'https://mcp.example.com/mcp',jwksUrl:'https://id.example.com/jwks',subjects:['owner']},targets:{}});
  const {privateKey,publicKey}=await generateKeyPair('ES256'); const auth=new Authenticator(config,async()=>publicKey);
  const sign=(audience:string,sub='owner',scope='shell:use',expiry='1m')=>new SignJWT({scope}).setProtectedHeader({alg:'ES256'}).setIssuer('https://id.example.com').setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  assert.equal((await auth.verify('Bearer '+await sign(config.publicUrl))).extra?.principal,'owner');
  for(const token of [await sign('other'),await sign(config.publicUrl,'stranger'),await sign(config.publicUrl,'owner','other'),await sign(config.publicUrl,'owner','shell:use','-1s')])await assert.rejects(auth.verify('Bearer '+token));
  assert.equal(auth.metadata().resource,config.publicUrl);
});
test('durable admission conflicts and restart recovery never replay uncertain jobs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shell-store-'));
  let db=new Store(dir);
  db.put('command',{id:'c',owner:'alice',state:'running',updatedAt:Date.now(),exitCode:null});
  db.put('input',{id:'i',owner:'alice',state:'accepted',updatedAt:Date.now(),commandId:'c'});
  db.remember('alice','s','key','hash','c');
  assert.equal(db.request('alice','s','key','hash'),'c');
  assert.throws(()=>db.request('alice','s','key','other'),/different content/);
  assert.throws(()=>db.get('command','c','bob'),/not owned/);db.close();
  db=new Store(dir);assert.equal(db.get('command','c','alice').state,'unknown');assert.equal(db.get('input','i','alice').state,'unknown');db.close();rmSync(dir,{recursive:true});
});
test('config rejects non-loopback listeners and unsafe target aliases',()=>{
  assert.throws(()=>parseConfig({host:'0.0.0.0',auth:{mode:'token'},targets:{}}));
  assert.throws(()=>parseConfig({auth:{mode:'token'},targets:{t:{sshAlias:'-oProxyCommand=bad',principals:['owner'],workspaces:{w:'/tmp'}}}}));
});
test('audit segment size has a bounded default and rejects unsafe limits',()=>{
  const config=parseConfig({auth:{mode:'token'},targets:{}});
  assert.equal(config.audit.maxFileBytes,10*1024*1024);
  assert.equal(parseConfig({auth:{mode:'token'},audit:{maxFileBytes:16384},targets:{}}).audit.maxFileBytes,16384);
  assert.throws(()=>parseConfig({auth:{mode:'token'},audit:{maxFileBytes:8192},targets:{}}));
  assert.throws(()=>parseConfig({auth:{mode:'token'},audit:{maxFileBytes:1073741825},targets:{}}));
});
