import assert from 'node:assert/strict';
import {handleCampaign} from './landing_campaign_endpoint.ts';
function request(action:string,body:unknown,origin='https://heroloop.xyz') {return new Request(`https://heroloop.xyz/api/v1/landing/${action}`,{method:'POST',headers:{origin,'content-type':'application/json',cookie:'__Host-hl_campaign_session=real; __Host-hl_campaign_binding=bound'},body:JSON.stringify(body)});}
Deno.test('campaign refuses cross-origin requests before forwarding',async()=>{
 const result=await handleCampaign(request('intent',{},'https://attacker.example'),'1',['https://heroloop.xyz'],()=>{throw new Error('must not forward');});assert.equal(result.status,403);
});
Deno.test('campaign ignores forged browser session, binding and origin',async()=>{
 const result=await handleCampaign(request('verify',{origin:'fake',token:'forged',binding:'forged'}),'2',['https://heroloop.xyz'],async(path,body)=>{assert.equal(path,'/campaign/verify');assert.equal(body.origin,'https://heroloop.xyz');assert.equal(body.token,'real');assert.equal(body.binding,'bound');return{session:'secret',wallet:'A'};});
 assert.equal(result.status,200);assert(!JSON.stringify(await result.json()).includes('secret'));assert.match(result.headers.get('set-cookie')??'',/Secure; HttpOnly; SameSite=Strict/);
});
Deno.test('campaign enforces streaming body limit',async()=>{
 const result=await handleCampaign(request('challenge',{junk:'a'.repeat(3000)}),'3',['https://heroloop.xyz'],()=>{throw new Error('must not forward');});assert.equal(result.status,413);
});
