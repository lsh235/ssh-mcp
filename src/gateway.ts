import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, readFileSync, readSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { Target } from './config.js';
import { assert, Fault, quote } from './core.js';

type Login = NonNullable<Target['postLogin']>;
interface Pending {resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;}
const agent=readFileSync(new URL('./runner/gateway.py',import.meta.url),'utf8');

// Resolve every value before connecting. Never return values or gate output to MCP.
export function loginValues(login:Login):string[] {
  return login.steps.map(step=>{
    let value:string;
    try {
      if('env' in step.valueFrom){
        const candidate=process.env[step.valueFrom.env];
        assert(candidate!==undefined,'LOGIN_SECRET_UNAVAILABLE','Login environment value is unavailable');value=candidate;
      }else{
        const fd=openSync(step.valueFrom.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try{
          const stat=fstatSync(fd);
          assert(stat.isFile()&&stat.uid===process.geteuid!()&&(stat.mode&0o077)===0&&stat.size<=1026,'LOGIN_SECRET_UNAVAILABLE','Login file must be private, owned by the service account and at most 1026 bytes');
          const data=Buffer.alloc(1027);let bytes=0,n=0;
          while(bytes<data.length&&(n=readSync(fd,data,bytes,data.length-bytes,null))>0)bytes+=n;
          assert(bytes<=1026,'LOGIN_SECRET_INVALID','Login file exceeds the input limit');
          value=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,bytes)).replace(/\r?\n$/,'');
        }finally{closeSync(fd);}
      }
      assert(Buffer.byteLength(value)<=1024&&!/[\x00-\x1f\x7f]/.test(value),'LOGIN_SECRET_INVALID','Login input must be one printable UTF-8 line of at most 1024 bytes');
      return value;
    }catch(error){
      if(error instanceof Fault)throw error;
      throw new Fault('LOGIN_SECRET_UNAVAILABLE','Login value could not be read securely on the MCP host');
    }
  });
}

export class GatewayChannel {
  private prefix=`__SM_${randomBytes(16).toString('hex')}__`;
  private buffer='';
  private pending=new Map<number,Pending>();
  private sequence=0;
  private closed=false;
  private rpc=false;
  private waiter?:{check:()=>void;fail:(error:Error)=>void};
  constructor(private channel:ChildProcessWithoutNullStreams,private lost:(reason:string)=>void){
    channel.stdout.setEncoding('utf8');
    channel.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      if(this.buffer.length>(this.rpc?16777216:65536)){this.fail('GATEWAY_PROTOCOL_FAILED');return;}
      if(this.rpc)this.frames();else this.waiter?.check();
    });
    // Login banners and echoed values are deliberately discarded, including stderr.
    channel.stderr.resume();
    channel.on('error',()=>this.fail('GATEWAY_DISCONNECTED'));
    channel.on('close',()=>this.fail('GATEWAY_DISCONNECTED'));
    channel.stdin.on('error',()=>this.fail('GATEWAY_DISCONNECTED'));
  }
  private fail(code:string){
    if(this.closed)return;this.closed=true;this.buffer='';
    const error=new Fault(code,'Post-login SSH channel is unavailable; no login output was retained');
    this.waiter?.fail(error);
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    this.channel.kill();this.lost(code);
  }
  private wait(expect:string,timeout:number,line=false,phase='readiness'):Promise<void>{
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Fault('LOGIN_TIMEOUT',`Post-login ${phase} was not confirmed`)),timeout);
      const finish=(error?:Error)=>{clearTimeout(timer);this.waiter=undefined;error?reject(error):resolve();};
      const check=()=>{
        const plain=stripVTControlCharacters(this.buffer).replace(/\r/g,'');
        const needle=line?'\n'+expect+'\n':expect;
        const text=line?'\n'+plain:plain, at=text.indexOf(needle);
        if(at>=0){this.buffer=plain.slice(at+needle.length-(line?1:0));finish();}
      };
      if(this.closed){finish(new Fault('GATEWAY_DISCONNECTED','Post-login channel closed'));return;}
      this.waiter={check,fail:error=>finish(error)};check();
    });
  }
  async open(login:Login,values:string[]){
    try{
      for(let i=0;i<login.steps.length;i++){
        await this.wait(login.steps[i].expect,login.timeoutMs,false,`prompt ${i+1}`);
        const enter={lf:'\n',cr:'\r',crlf:'\r\n'}[login.lineEnding];
        this.channel.stdin.write(values[i]+enter);values[i]='';
      }
      await this.wait(login.ready,login.timeoutMs,false,'shell prompt');
      this.buffer='';
      // Keep the initial canonical terminal command short. Transfer the full agent
      // only after Python confirms raw/no-echo mode, avoiding PTY line limits.
      const boot=`import sys;print('\\n${this.prefix}BOOT',flush=True);n=int(sys.stdin.buffer.readline());exec(compile(sys.stdin.buffer.read(n),'<shell-mcp-gateway>','exec'))`;
      const bootReady=this.wait(this.prefix+'BOOT',15000,true,'bootstrap');
      this.channel.stdin.write(`stty raw -echo && exec python3 -u -c ${quote(boot)} ${quote(this.prefix)}\r`);
      await bootReady;
      const ready=this.wait(this.prefix+'READY',15000,true,'agent');
      this.channel.stdin.write(Buffer.concat([Buffer.from(Buffer.byteLength(agent)+'\n'),Buffer.from(agent)]));
      await ready;this.buffer='';this.rpc=true;
    }catch(error){this.close();throw error;}
    finally{values.fill('');}
  }
  private frames(){
    while(true){
      const end=this.buffer.indexOf('\n');if(end<0)return;
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      if(!line.startsWith(this.prefix)){this.fail('GATEWAY_PROTOCOL_FAILED');return;}
      let value:Record<string,unknown>;
      try{value=JSON.parse(line.slice(this.prefix.length));}catch{this.fail('GATEWAY_PROTOCOL_FAILED');return;}
      if(value.event==='worker_lost'){this.lost('SHELL_EXITED');continue;}
      const p=this.pending.get(value.id as number);if(!p)continue;
      this.pending.delete(value.id as number);clearTimeout(p.timer);
      if(value.error)p.reject(new Fault('GATEWAY_OPERATION_FAILED','Post-login remote operation failed'));
      else p.resolve(value);
    }
  }
  request(args:Record<string,unknown>,timeout=17000):Promise<Record<string,unknown>>{
    assert(!this.closed&&this.rpc,'GATEWAY_DISCONNECTED','Post-login channel is unavailable');
    assert(this.pending.size<32,'GATEWAY_BUSY','Too many pending post-login operations');
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail('GATEWAY_TIMEOUT'),timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.channel.stdin.write(JSON.stringify({...args,id})+'\n');
    });
  }
  async exec(command:string,input:string,maximum:number,timeout:number){
    const r=await this.request({op:'exec',command,input,maximum,timeout:timeout/1000},timeout+2000);
    assert(typeof r.code==='number'&&typeof r.stdout==='string'&&typeof r.stderr==='string','GATEWAY_PROTOCOL_FAILED','Invalid remote execution result');
    if(r.limit)throw new Fault('OUTPUT_LIMIT','Remote helper response exceeds limit');
    if(r.timeout)throw new Fault('REMOTE_TIMEOUT','Remote helper exceeded its deadline');
    return {code:r.code,stdout:Buffer.from(r.stdout,'base64').toString('utf8'),stderr:Buffer.from(r.stderr,'base64').toString('utf8')};
  }
  async start(worker:string,dir:string,root:string,maximum:number){await this.request({op:'start',worker,dir,root,maximum});}
  async submit(commandId:string){await this.request({op:'submit',commandId});}
  close(){this.fail('GATEWAY_DISCONNECTED');}
}
