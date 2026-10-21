import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
// Protocol adapter only: no LLM, no scripted fixes, no OpenAI API credentials.
const runtime=JSON.parse(readFileSync(resolve('.state/docker-demo/runtime.json'),'utf8'));
const input=JSON.parse(readFileSync(0,'utf8'));
const client=new Client({name:'current-codex-session-bridge',version:'0.1.0'},{versionNegotiation:{mode:'auto'}});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url),{requestInit:{headers:{Authorization:'Bearer '+runtime.token}}}));
  const result=input.method==='tools/list'?await client.listTools():await client.callTool({name:input.tool,arguments:input.arguments??{}});
  const entry={at:new Date().toISOString(),actor:'current Codex conversation via MCP SDK bridge',protocol:client.getNegotiatedProtocolVersion(),request:input,response:result};
  const logDir=resolve(process.env.SHELL_MCP_TRANSCRIPT_DIR??'test-results/docker-demo');
  mkdirSync(logDir,{recursive:true});
  appendFileSync(resolve(logDir,'transcript.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});
  console.log(JSON.stringify(input.method==='tools/list'?{protocol:client.getNegotiatedProtocolVersion(),tools:result.tools.map(t=>({name:t.name,description:t.description}))}:result.structuredContent??result,null,2));
  if(result.isError)process.exitCode=2;
}finally{await client.close();}
