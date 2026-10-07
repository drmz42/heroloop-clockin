type Json=Record<string,unknown>;
const actions=new Set(['challenge','verify','profile','logout','intent','confirm']);
const budgets=new Map<string,{at:number,count:number}>();
const reply=(status:number,body:Json,cookie?:string)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store',...(cookie?{'set-cookie':cookie}:{})}});
const cookie=(name:string,value:string,age:number)=>`__Host-hl_campaign_${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
function readCookie(request:Request,name:string):string {
 return request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`__Host-hl_campaign_${name}=`))?.split('=')[1]??'';
}
export async function handleCampaign(request:Request,client:string,origins:readonly string[],proxy:(path:string,body:Json)=>Promise<Json>):Promise<Response> {
 const action=new URL(request.url).pathname.split('/').at(-1)??'';
 if(request.method!=='POST'||!actions.has(action)) return reply(404,{ok:false,code:'not_found'});
 const origin=request.headers.get('origin')??'';
 if(!origins.includes(origin)) return reply(403,{ok:false,code:'campaign_invalid_origin'});
 const now=Date.now();
 for(const [key,b] of budgets) if(now-b.at>60000) budgets.delete(key);
 const budget=budgets.get(client)??{at:now,count:0};
 if(budget.count>=30||(!budgets.has(client)&&budgets.size>=2000)) return reply(429,{ok:false,code:'campaign_rate_limited'});
 budget.count++;budgets.set(client,budget);
 if(!(request.headers.get('content-type')??'').startsWith('application/json'))return reply(400,{ok:false,code:'invalid_json'});
 const reader=request.body?.getReader();let raw='';let size=0;
 if(!reader)return reply(400,{ok:false,code:'invalid_json'});
 const decoder=new TextDecoder();
 while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2048){await reader.cancel();return reply(413,{ok:false,code:'body_too_large'});}raw+=decoder.decode(r.value,{stream:true});}
 let body:Json;
 try {const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();body=parsed;}catch{return reply(400,{ok:false,code:'invalid_json'});}
 const binding=action==='challenge'?crypto.randomUUID():readCookie(request,'binding');
 try {
  // Never forward a browser-supplied origin, session or challenge binding.
  const result=await proxy(`/campaign/${action}`,{...body,origin,binding,token:readCookie(request,'session')});
  const session=typeof result.session==='string'?result.session:null;
  delete result.session;
  const setCookie=action==='challenge'?cookie('binding',binding,300):action==='logout'?cookie('session','',0):session?cookie('session',session,604800):undefined;
  return reply(200,{ok:true,result},setCookie);
 }catch(error){const code=(error instanceof Error?error.message:'').match(/^campaign_[a-z_]+$/)?.[0]??'campaign_unavailable';return reply(code==='campaign_sign_in_required'?401:409,{ok:false,code});}
}
