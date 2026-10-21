import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, verifyAuditFile } from '../src/audit.js';

function temp() { return mkdtempSync(join(tmpdir(),'shell-mcp-audit-')); }

test('audit records form a durable hash chain and the verifier reports its head',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl');
  const log=new AuditLog(path);
  log.append({event:'command_accepted',owner:'alice',id:'c_test',state:'accepted'});
  log.append({event:'command_finished',owner:'alice',id:'c_test',state:'completed'});
  log.close();
  const result=verifyAuditFile(path);
  assert.deepEqual({valid:result.valid,chainStarted:result.chainStarted,legacyRecords:result.legacyRecords,chainedRecords:result.chainedRecords},
    {valid:true,chainStarted:true,legacyRecords:0,chainedRecords:3});
  assert.match(result.headHash??'',/^[a-f0-9]{64}$/);
  const records=readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records[1].previousHash,records[0].hash);
  assert.equal(records[2].previousHash,records[1].hash);
  assert.equal(Object.hasOwn(records[1],'command'),false);
  assert.equal(existsSync(join(dir,'audit.jsonl.lock')),false);
  rmSync(dir,{recursive:true,force:true});
});

test('audit verifier rejects modified, removed, or incomplete records',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl');
  const log=new AuditLog(path);
  log.append({event:'command_accepted',owner:'alice',id:'c_test',state:'accepted'});
  log.append({event:'command_finished',owner:'alice',id:'c_test',state:'completed'});
  log.close();
  const original=readFileSync(path,'utf8').trimEnd().split('\n');

  const changed=JSON.parse(original[1]); changed.state='cancelled';
  writeFileSync(path,[original[0],JSON.stringify(changed),original[2],''].join('\n'));
  assert.throws(()=>verifyAuditFile(path),/AUDIT_LOG_INVALID: record hash does not match/);

  writeFileSync(path,[original[0],original[2],''].join('\n'));
  assert.throws(()=>verifyAuditFile(path),/AUDIT_LOG_INVALID: sequence or previous hash/);

  writeFileSync(path,original.join('\n'));
  assert.throws(()=>verifyAuditFile(path),/AUDIT_LOG_INVALID: file ends with an incomplete record/);
  rmSync(dir,{recursive:true,force:true});
});

test('legacy audit records are checkpointed and their bytes remain verifiable',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl');
  const legacy={at:'2026-10-21T12:00:00.000Z',event:'session_open',owner:'alice',id:'s_test',state:'ready'};
  writeFileSync(path,JSON.stringify(legacy)+'\n',{mode:0o600});
  let log=new AuditLog(path); log.close();
  let result=verifyAuditFile(path);
  assert.equal(result.legacyRecords,1); assert.equal(result.chainedRecords,1); assert.equal(result.chainStarted,true);

  const lines=readFileSync(path,'utf8').trimEnd().split('\n');
  legacy.state='closed';
  writeFileSync(path,[JSON.stringify(legacy),...lines.slice(1),''].join('\n'));
  assert.throws(()=>verifyAuditFile(path),/AUDIT_LOG_INVALID: legacy checkpoint does not match/);
  rmSync(dir,{recursive:true,force:true});
});

test('only one process can write a state directory audit chain at a time',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl');
  const first=new AuditLog(path);
  assert.throws(()=>new AuditLog(path),/AUDIT_LOCKED: another process/);
  first.close();
  const second=new AuditLog(path); second.close();
  rmSync(dir,{recursive:true,force:true});
});

test('audit writer refuses a symlink in place of its log file',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl'), destination=join(dir,'other.jsonl');
  writeFileSync(destination,''); symlinkSync(destination,path);
  assert.throws(()=>new AuditLog(path));
  assert.equal(readFileSync(destination,'utf8'),'');
  rmSync(dir,{recursive:true,force:true});
});

test('size rotation preserves and verifies the full chain across restart',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl'), maxFileBytes=16384, events=160;
  let log=new AuditLog(path,{maxFileBytes});
  for(let i=0;i<events;i++)log.append({event:'command_finished',owner:'alice',id:`c_${i}`,state:'completed'});
  log.close();
  let result=verifyAuditFile(path);
  assert.ok(result.segments>1);
  assert.equal(readdirSync(dir).filter(name=>name.includes('.segment-')).length,result.segments-1);
  assert.equal(result.chainedRecords,1+events+2*(result.segments-1));

  log=new AuditLog(path,{maxFileBytes});
  log.append({event:'command_finished',owner:'alice',id:'c_after_restart',state:'completed'});
  log.close();
  result=verifyAuditFile(path);
  assert.equal(result.chainedRecords,1+events+1+2*(result.segments-1));
  rmSync(dir,{recursive:true,force:true});
});

test('verifier detects a removed archived segment instead of accepting a shortened chain',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl');
  const log=new AuditLog(path,{maxFileBytes:16384});
  for(let i=0;i<120;i++)log.append({event:'command_finished',owner:'alice',id:`c_${i}`,state:'completed'});
  log.close();
  const archive=readdirSync(dir).filter(name=>name.includes('.segment-')).sort()[0];
  assert.ok(archive);
  unlinkSync(join(dir,archive));
  assert.throws(()=>verifyAuditFile(path),/AUDIT_LOG_INVALID/);
  rmSync(dir,{recursive:true,force:true});
});

test('startup recovers interrupted rotation before and after archive linking',()=>{
  for(const stage of ['before_promote','after_archive_link']){
    const dir=temp(), path=join(dir,'audit.jsonl'), maxFileBytes=16384;
    let log=new AuditLog(path,{maxFileBytes});
    for(let i=0;i<100;i++)log.append({event:'command_finished',owner:'alice',id:`c_${i}`,state:'completed'});
    log.close();
    const archives=readdirSync(dir).filter(name=>name.includes('.segment-')).sort();
    const newest=archives.at(-1);
    assert.ok(newest);
    const segmentStart=readFileSync(path,'utf8').split('\n')[0]+'\n';
    writeFileSync(`${path}.next`,segmentStart,{mode:0o600});
    unlinkSync(path);
    if(stage==='after_archive_link')linkSync(join(dir,newest),path);

    log=new AuditLog(path,{maxFileBytes});
    log.append({event:'command_finished',owner:'alice',id:`recovered_${stage}`,state:'completed'});
    log.close();
    assert.equal(verifyAuditFile(path).valid,true);
    rmSync(dir,{recursive:true,force:true});
  }
});

test('verifier and a second writer cannot race the active audit log',()=>{
  const dir=temp(), path=join(dir,'audit.jsonl'), log=new AuditLog(path);
  assert.throws(()=>verifyAuditFile(path),/AUDIT_LOCKED/);
  assert.throws(()=>new AuditLog(path),/AUDIT_LOCKED/);
  log.close();
  rmSync(dir,{recursive:true,force:true});
});
