// ORE stays in the player's Mine custody. The existing float pays the network
// fee; both authorities sign. Only an approved, reserved request can be signed.
import {ORE_TOKEN_MINT,TOKEN_PROGRAM} from './chain.ts';
import {oreTokenAddress,ORE_DECIMALS,type Instruction} from './ore.ts';
import {custodyKey,floatKey,type MineDeps} from './mine_runner.ts';
import {actionId,prepareAction} from './mine_actions.ts';
import {tokenCustodyBalance} from './payout_custody.ts';
import {hasSkrAccount} from './recipient_account.ts';
type Json=Record<string,unknown>;
export async function prepareOrePayout(deps:MineDeps,request:string):Promise<Json>{
 const w=await deps.call('SELECT seeker_skr.withdrawal_admin_get($1::uuid) AS result',[request]);
 if(w.asset!=='ORE'||w.status!=='paying'||typeof w.player_id!=='string'||typeof w.destination!=='string'
  ||typeof w.payout_minor!=='string'||!/^[1-9][0-9]{0,19}$/.test(w.payout_minor))throw new Error('withdrawal_state_conflict');
 const custody=await custodyKey(deps.master,w.player_id),float=await floatKey(deps.master);
 if(w.destination===custody.address||w.destination===float.address)throw new Error('invalid_wallet_address');
 if(!await hasSkrAccount(w.destination,ORE_TOKEN_MINT,deps.rpc,ORE_DECIMALS))throw new Error('recipient_ore_account_required');
 const amount=BigInt(w.payout_minor);
 if(amount>18446744073709551615n)throw new Error('invalid_amount');
 if(await tokenCustodyBalance([custody.address],ORE_TOKEN_MINT,ORE_DECIMALS,deps.rpc)<amount)throw new Error('ore_custody_shortfall');
 const source=await oreTokenAddress(custody.address),destination=await oreTokenAddress(w.destination);
 const ix:Instruction={program:TOKEN_PROGRAM,accounts:[
  {address:source,signer:false,writable:true},{address:ORE_TOKEN_MINT,signer:false,writable:false},
  {address:destination,signer:false,writable:true},{address:custody.address,signer:true,writable:false}],
  data:Uint8Array.from([12,...Array.from({length:8},(_,i)=>Number(amount>>BigInt(i*8)&255n)),ORE_DECIMALS])};
 const a=await prepareAction(deps,await actionId(`payout:${request}`),null,request,'ore_payout',float,[ix],custody);
 if(a.status==='attention')throw new Error('mine_action_review_required');
 return {transaction:a.wire,signature:a.signature,last_valid_height:Number(a.last_valid_height)};
}
