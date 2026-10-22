import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseConfig } from '../dist/config.js';
import { startServer } from '../dist/server.js';
const dir=mkdtempSync(join(tmpdir(),'shell-mcp-smoke-'));
process.env.SHELL_MCP_SMOKE_TOKEN=randomBytes(32).toString('hex');
const runtime=await startServer(parseConfig({port:0,stateDir:dir,auth:{mode:'token',tokenEnv:'SHELL_MCP_SMOKE_TOKEN'},targets:{}}));
const client=new Client({name:'built-artifact-smoke',version:'0.1.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
try {
  const port=runtime.server.address().port;
  const health=await fetch(`http://127.0.0.1:${port}/health`);if(!health.ok)throw new Error('health failed');
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+process.env.SHELL_MCP_SMOKE_TOKEN}}}));
  const tools=await client.listTools();if(tools.tools.length!==25)throw new Error('tool discovery failed');
  const result=await client.callTool({name:'list_targets',arguments:{}});if(result.isError)throw new Error('tool invocation failed');
  console.log('PASS: compiled HTTP server health, authenticated MCP discovery and tool invocation (25 tools)');
}finally{await client.close();await runtime.stop();delete process.env.SHELL_MCP_SMOKE_TOKEN;rmSync(dir,{recursive:true,force:true});}
