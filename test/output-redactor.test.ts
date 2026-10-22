import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretOutputRedactor } from '../src/output-redactor.js';

test('masks exact secrets that span chunks without changing byte length',()=>{
  const secret='fixture credential';
  const redactor=new SecretOutputRedactor([secret]);
  const first=redactor.push(Buffer.from('before fixture '));
  const second=redactor.push(Buffer.from('credential after'));
  const result=Buffer.concat([first,second,redactor.finish()]);
  assert.equal(result.toString(),`before ${'*'.repeat(Buffer.byteLength(secret))} after`);
  assert.equal(result.length,Buffer.byteLength('before fixture credential after'));
});

test('detects overlapping secrets and preserves UTF-8 byte cursors',()=>{
  const secret='암호abcd';
  const encoded=Buffer.from(`prefix-${secret}-suffix`);
  const redactor=new SecretOutputRedactor([secret,'abcd','cdef']);
  const chunks=[encoded.subarray(0,9),encoded.subarray(9,12),encoded.subarray(12)];
  const result=Buffer.concat([...chunks.map(chunk=>redactor.push(chunk)),redactor.finish()]);
  const expected=Buffer.from(`prefix-${'*'.repeat(Buffer.byteLength(secret))}-suffix`);
  assert.deepEqual(result,expected);
  assert.equal(result.length,encoded.length);

  const overlap=new SecretOutputRedactor(['abcd','cdef']);
  assert.equal(Buffer.concat([overlap.push(Buffer.from('ab')),overlap.push(Buffer.from('cdef')),overlap.finish()]).toString(),'******');
});

test('masks a recognizable secret prefix at stream end and is idempotent',()=>{
  const redactor=new SecretOutputRedactor(['token-value']);
  const first=redactor.push(Buffer.from('start token-va'));
  const tail=redactor.finish();
  assert.equal(Buffer.concat([first,tail]).toString(),'start ********');
  assert.equal(redactor.finish().length,0);
});

test('emits PTY output promptly unless its tail can still become a configured secret',()=>{
  const secret='fixture $() ` ~\\! 한글';
  const redactor=new SecretOutputRedactor(['fixture-user',secret]);
  const input=Buffer.from(`READY:True:fixture-user\r\nSECRET:${secret}`);
  const visible=redactor.push(input);
  assert.deepEqual(visible,Buffer.from(`READY:True:${'*'.repeat(Buffer.byteLength('fixture-user'))}\r\nSECRET:${'*'.repeat(Buffer.byteLength(secret))}`));
  assert.equal(redactor.finish().length,0);
  const partial=new SecretOutputRedactor([secret]);
  const prefix=Buffer.from('screen text '+secret.slice(0,5));
  assert.equal(partial.push(prefix).toString(),'screen text ');
  assert.equal(partial.finish().toString(),'*'.repeat(5));
});

test('does not delay or modify output when no gate values are configured',()=>{
  const redactor=new SecretOutputRedactor([]);
  const input=Buffer.from([0,0x61,0xff]);
  assert.deepEqual(redactor.push(input),input);
  assert.equal(redactor.finish().length,0);
});
