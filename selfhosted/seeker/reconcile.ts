// Read-only CLI, run inside the private wallet container. No retained player data.
const token=Deno.env.get('WALLET_SERVICE_TOKEN');
if(!token)throw new Error('wallet service token unavailable');
const response=await fetch('http://127.0.0.1:8090/wallet/reconcile',{
 method:'POST',headers:{'content-type':'application/json','x-wallet-token':token},
 body:JSON.stringify({player_id:'00000000-0000-4000-8000-000000000001'}),signal:AbortSignal.timeout(20000),
});
const body=await response.json();
if(!response.ok||body.ok!==true)throw new Error('reconciliation unavailable');
console.log(JSON.stringify(body.result,null,2));
if(body.result.withdrawals_blocked)Deno.exit(1);
