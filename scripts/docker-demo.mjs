import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dir=join(project,'.state/docker-demo');
const name='shell-mcp-demo-target', image='shell-mcp-demo-target:local';
const run=(exe,args,options={})=>execFileSync(exe,args,{encoding:'utf8',...options});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
process.umask(0o077);
mkdirSync(dir,{recursive:true,mode:0o700});
const operation=process.argv[2]??'start';
if(operation==='stop'){
  if(existsSync(join(dir,'runtime.json'))){
    const runtime=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8'));
    try {
      const command=readFileSync(`/proc/${runtime.serverPid}/cmdline`,'utf8');
      if(command.includes(join(project,'dist/cli.js'))&&command.includes(join(dir,'config.json')))process.kill(runtime.serverPid,'SIGTERM');
    }catch{}
    const owner=run('docker',['inspect','--format','{{index .Config.Labels "shell-mcp.demo"}}',name]).trim();
    if(owner!==project)throw new Error('Refusing to stop a container owned by another workspace');
    run('docker',['stop',name]);
    console.log(JSON.stringify({container:name,status:'stopped'}));
  }
}else if(operation==='resume'||operation==='reload'){
  const runtime=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8'));
  if(operation==='reload'){
    const owned=()=>{try{const command=readFileSync(`/proc/${runtime.serverPid}/cmdline`,'utf8');return command.includes(join(project,'dist/cli.js'))&&command.includes(join(dir,'config.json'));}catch{return false;}};
    if(owned()){
      process.kill(runtime.serverPid,'SIGTERM');
      const until=performance.now()+20000;
      while(owned()&&performance.now()<until)await sleep(50);
      if(owned())throw new Error('Owned MCP process did not stop; refusing a second writer');
    }
  }
  const inspect=JSON.parse(run('docker',['inspect',name]))[0];
  if(inspect.Id!==runtime.containerId||inspect.Config.Labels['shell-mcp.demo']!==project)throw new Error('Container identity changed');
  if(!inspect.State.Running)run('docker',['start',name]);
  const port=run('docker',['port',name,'22/tcp']).trim().split(':').at(-1);
  const hostKey=readFileSync(join(dir,'host.pub'),'utf8').trim().split(' ').slice(0,2).join(' ');
  writeFileSync(join(dir,'known_hosts'),`[127.0.0.1]:${port} ${hostKey}\n`);
  writeFileSync(join(dir,'ssh_config'),readFileSync(join(dir,'ssh_config'),'utf8').replace(/^ Port \d+$/m,` Port ${port}`));
  let serverAlive=false;
  try{const command=readFileSync(`/proc/${runtime.serverPid}/cmdline`,'utf8');serverAlive=command.includes(join(project,'dist/cli.js'))&&command.includes(join(dir,'config.json'));}catch{}
  if(!serverAlive){
    const log=openSync(join(dir,'server.log'),'a',0o600);
    const server=spawn(process.execPath,[join(project,'dist/cli.js'),'--config',join(dir,'config.json')],{cwd:project,env:{...process.env,SHELL_MCP_DEMO_TOKEN:runtime.token},detached:true,stdio:['ignore',log,log]});server.unref();runtime.serverPid=server.pid;
  }
  runtime.sshPort=Number(port);writeFileSync(join(dir,'runtime.json'),JSON.stringify(runtime,null,2)+'\n');
  let ready=false;for(let attempt=0;attempt<50;attempt++){try{if((await fetch(new URL('/health',runtime.url))).ok){ready=true;break;}}catch{}await sleep(100);}
  if(!ready)throw new Error('MCP server not ready; inspect private log');
  console.log(JSON.stringify({container:name,url:runtime.url,serverPid:runtime.serverPid,status:'running'}));
}else if(operation==='status'){
  const runtime=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8'));
  console.log(JSON.stringify({container:name,url:runtime.url,serverPid:runtime.serverPid}));
}else if(operation==='start'){
  if(existsSync(join(dir,'runtime.json')))throw new Error('Demo already provisioned; inspect status or stop it. Do not overwrite credentials.');
  // Build context contains only intentionally public demo source; no local keys or Codex state.
  run('docker',['build','-t',image,join(project,'test/docker')],{stdio:'inherit'});
  for(const key of ['host','client'])run('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(dir,key)]);
  const targetKeys=join(dir,'target-keys');mkdirSync(targetKeys,{mode:0o755});
  copyFileSync(join(dir,'host'),join(targetKeys,'host'));
  copyFileSync(join(dir,'client.pub'),join(targetKeys,'client.pub'));
  chmodSync(join(targetKeys,'host'),0o600);chmodSync(join(targetKeys,'client.pub'),0o644);
  const id=run('docker',['run','-d','--name',name,'--label',`shell-mcp.demo=${project}`,'--pids-limit','128','--memory','256m','--cpus','1','--cap-drop','ALL','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SYS_CHROOT','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','NET_BIND_SERVICE','-p','127.0.0.1::22','--mount',`type=bind,src=${targetKeys},dst=/run/demo-keys,readonly`,image]).trim();
  const port=run('docker',['port',name,'22/tcp']).trim().split(':').at(-1);
  const hostKey=readFileSync(join(dir,'host.pub'),'utf8').trim().split(' ').slice(0,2).join(' ');
  writeFileSync(join(dir,'known_hosts'),`[127.0.0.1]:${port} ${hostKey}\n`);
  writeFileSync(join(dir,'ssh_config'),`Host docker-demo\n HostName 127.0.0.1\n User developer\n Port ${port}\n IdentityFile ${join(dir,'client')}\n IdentitiesOnly yes\n UserKnownHostsFile ${join(dir,'known_hosts')}\n GlobalKnownHostsFile /dev/null\n`);
  // Allocate a loopback MCP port. This demo is single-user and keeps credentials private.
  const {createServer}=await import('node:net'); const probe=createServer();
  await new Promise(r=>probe.listen(0,'127.0.0.1',r));const mcpPort=probe.address().port;await new Promise(r=>probe.close(r));
  const url=`http://127.0.0.1:${mcpPort}/mcp`, token=randomBytes(32).toString('hex');
  const config={host:'127.0.0.1',port:mcpPort,publicUrl:url,stateDir:join(dir,'server-state'),auth:{mode:'token',tokenEnv:'SHELL_MCP_DEMO_TOKEN'},targets:{'docker-demo':{description:'Isolated Docker SSH development target',sshAlias:'docker-demo',sshConfig:join(dir,'ssh_config'),principals:['owner'],workspaces:{project:'/workspace/project'}}}};
  writeFileSync(join(dir,'config.json'),JSON.stringify(config,null,2)+'\n');
  const log=openSync(join(dir,'server.log'),'a',0o600);
  const server=spawn(process.execPath,[join(project,'dist/cli.js'),'--config',join(dir,'config.json')],{cwd:project,env:{...process.env,SHELL_MCP_DEMO_TOKEN:token},detached:true,stdio:['ignore',log,log]});server.unref();
  writeFileSync(join(dir,'runtime.json'),JSON.stringify({containerId:id,container:name,image,url,serverPid:server.pid,token,sshPort:Number(port)},null,2)+'\n');
  let ready=false;
  for(let attempt=0;attempt<50;attempt++){
    try{const response=await fetch(new URL('/health',url));if(response.ok){ready=true;break;}}catch{}await sleep(100);
  }
  if(!ready)throw new Error('MCP server did not start; inspect private server.log');
  console.log(JSON.stringify({container:name,containerId:id,url,serverPid:server.pid,sshPort:Number(port),credentials:'private files under .state/docker-demo; never print runtime.json'}));
}else throw new Error('Usage: node scripts/docker-demo.mjs start|resume|reload|status|stop');
