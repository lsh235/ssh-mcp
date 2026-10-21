#!/usr/bin/env node
import { loadConfig } from './config.js';
import { startServer } from './server.js';
const args=process.argv.slice(2);
if(args.includes('--help')) {
  console.log('Shell MCP 0.9.0\nUsage: node dist/cli.js --config /absolute/path/config.json\nRequires: Linux, Node >=22.16, OpenSSH; target: Bash, Python >=3.9, setsid.\nCredentials are read only on this MCP host. See docs/OPERATIONS.md.');
}else if(args.includes('--version'))console.log('0.9.0');
else {
  try {
    process.umask(0o077);
    const index=args.indexOf('--config');if(index<0||!args[index+1])throw new Error('Use --config <path>');
    const config=loadConfig(args[index+1]), runtime=await startServer(config);
    const address=runtime.server.address();
    console.log(JSON.stringify({event:'listening',host:config.host,port:typeof address==='object'?address?.port:config.port}));
    let stopping=false;
    const stop=()=>{if(stopping)return;stopping=true;void runtime.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(error){console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;}
}
