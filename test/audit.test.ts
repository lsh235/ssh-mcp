import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.throws(()=>new AuditLog(path),/AUDIT_LOCKED: another server process/);
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
