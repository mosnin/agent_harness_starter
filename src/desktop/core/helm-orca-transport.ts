import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
export interface OrcaMetadata {runtimeId:string;pid:number;authToken:string|null;transports:Array<{kind:string;endpoint:string}>}
/** Pinned Orca bf4e270 local JSON-lines RPC; total deadline, bounded frames, no retry. */
export function orcaRequest(meta:OrcaMetadata,method:string,params:unknown,options:{requestId?:string;signal?:AbortSignal;timeoutMs?:number}={}):Promise<any>{
  return new Promise((resolve,reject)=>{
    if(options.signal?.aborted){reject(new Error('Cancelled before Orca dispatch'));return;}
    const endpoint=meta.transports.find(t=>t.kind==='unix')?.endpoint;if(!endpoint){reject(new Error('Orca local socket unavailable'));return;}
    const id=randomUUID(),socket=createConnection(endpoint);let text='',settled=false;
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(value);};
    const abort=()=>finish(new Error('Orca request cancelled; mutation outcome may be unknown'));
    const timer=setTimeout(()=>finish(new Error('Orca total request deadline exceeded; outcome unknown')),options.timeoutMs??45000);
    options.signal?.addEventListener('abort',abort,{once:true});socket.setEncoding('utf8');
    socket.on('error',()=>finish(new Error('Orca connection failed; outcome unknown')));socket.on('close',()=>finish(new Error('Orca closed before acknowledgement')));
    socket.on('connect',()=>{if(options.signal?.aborted){abort();return;}socket.write(JSON.stringify({id,authToken:meta.authToken,method,params,orchestrationContractVersion:1,...(options.requestId?{orchestrationRequestId:options.requestId}:{})})+'\n');});
    socket.on('data',(chunk:string)=>{text+=chunk;if(Buffer.byteLength(text)>2*1024*1024){finish(new Error('Orca response exceeds bound'));return;}let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n);text=text.slice(n+1);if(!line.trim())continue;try{const frame=JSON.parse(line);if(frame._keepalive===true)continue;if(frame.id!==id||frame._meta?.runtimeId!==meta.runtimeId)throw new Error('Orca response identity mismatch');if(frame.ok!==true)throw new Error(typeof frame.error?.code==='string'?'Orca refusal: '+frame.error.code:'Invalid Orca response');finish(undefined,frame.result);}catch(e){finish(e instanceof Error?e:new Error('Malformed Orca frame'));}if(settled)return;}});
  });
}
