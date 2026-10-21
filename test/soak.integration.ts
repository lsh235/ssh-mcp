import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShellService} from '../src/service.js';
import {sleep} from '../src/core.js';
import {fixture} from './fixture.js';
test('121-second SSH job exposes live output and retains shell afterwards',{timeout:140000},async()=>{
  const f=await fixture();f.config.limits.pollMs=1000;const service=new ShellService(f.config);
  try{
    const s=await service.open('owner','test','project','long');
    const c=await service.run('owner',s.id,'export LONG_JOB=retained; printf started; sleep 121; printf finished','job',0,130000);
    await sleep(1600);
    assert.equal(service.command('owner',c.id).state,'running');
    assert.equal(service.readOutput('owner',c.id,'stdout').content,'started');
    const end=performance.now()+130000;
    while(performance.now()<end&&['accepted','running'].includes(service.command('owner',c.id).state))await sleep(500);
    const result=service.command('owner',c.id);assert.equal(result.state,'completed');assert.equal(result.exitCode,0);
    assert.ok((result.elapsedMs as number)>=121000);
    assert.equal(service.readOutput('owner',c.id,'stdout').content,'startedfinished');
    const verify=await service.run('owner',s.id,'printf "$LONG_JOB"','verify',5000);
    assert.equal(verify.exitCode,0);assert.equal(service.readOutput('owner',verify.id,'stdout').content,'retained');
  }finally{await service.shutdown();await f.close();}
});
