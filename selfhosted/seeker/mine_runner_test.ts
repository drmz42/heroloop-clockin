import assert from 'node:assert/strict';
import { base58Decode } from './chain.ts';
import { ORE_BOARD, ORE_PROGRAM, COMPUTE_BUDGET_PROGRAM, minerAddress } from './ore.ts';
import { custodyDelta, custodyKey, deriveMineKey, floatKey, finish, mineTick, minePolicy, sessionSquares, transferInstruction } from './mine_runner.ts';

const master = new Uint8Array(32).fill(7);
const PLAYER = '10000000-0000-4000-8000-000000000001';
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function sharedMaster():Promise<Uint8Array>{
  const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
  const secret=new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).slice(-32);
  const publicKey=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  return Uint8Array.from([...secret,...publicKey]);
}
Deno.test('shared hackathon mode uses exactly one existing signer for every player',async()=>{
 const m=await sharedMaster(),a=await custodyKey(m,PLAYER),b=await custodyKey(m,'other'),project=await floatKey(m);
 assert.equal(a.address,b.address);assert.equal(a.address,project.address);
 assert.deepEqual(base58Decode(a.address),m.slice(32));
 const message=new TextEncoder().encode('shared-project-mine');
 const publicKey=await crypto.subtle.importKey('raw',ab(m.slice(32)),{name:'Ed25519'},false,['verify']);
 assert.equal(await crypto.subtle.verify('Ed25519',publicKey,ab(await a.sign(message)),ab(message)),true);
 const {parseMineMaster}=await import('./mine_service.ts');
 const encoded=b64(m).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 assert.deepEqual(parseMineMaster(encoded),m);
 const bad=m.slice();bad[63]^=1;
 await assert.rejects(floatKey(bad),/invalid_mine_project_keypair/);
});
Deno.test('shared session closes without self-transfer or scanning another player claims',async()=>{
 const m=await sharedMaster(),key=await floatKey(m);const calls:string[]=[];
 await finish({master:m,oreEnabled:true,call:async(sql)=>{calls.push(sql);return {};},rpc:async(method)=>{
  if(method==='getAccountInfo')return {value:null};
  if(method==='getSignaturesForAddress')return [];
  if(method==='getBalance')return {value:85000000};
  throw new Error(`unexpected shared wallet action ${method}`);
 }},{id:'session'},key,key,{} as never);
 assert.equal(calls.filter(sql=>sql.includes('mine_session_close')).length,1);
 assert.equal(calls.some(sql=>sql.includes('mine_credit(')||sql.includes('mine_action_prepare')),false);
});
Deno.test('shared start distinguishes a busy miner from missing project liquidity before reservation',async()=>{
 const m=await sharedMaster();const {mineRoute}=await import('./mine_service.ts');
 const body={tier:'0.00001',rounds:1,squares:[0],session_id:'aaaaaaaa-0000-4000-8000-000000000001'};
 let sessions:Record<string,unknown>[]=[];let saved:unknown[]=[];let balance=0;
 const call=async(sql:string,args:unknown[])=>{
  if(sql.includes('mine_runner_work'))return {sessions};
  saved=args;return {};
 };
 const rpc=async()=>({value:balance});
 const poor=await mineRoute('/wallet/mine/start',PLAYER,body,m,call,rpc,true);
 assert.equal((await poor!.json()).code,'mining_project_liquidity_unavailable');assert.deepEqual(saved,[]);
 sessions=[{reserved_minor:'100',spent_minor:'0'}];balance=85000000;
 const busy=await mineRoute('/wallet/mine/start',PLAYER,body,m,call,rpc,true);
 assert.equal((await busy!.json()).code,'mining_shared_wallet_busy');assert.deepEqual(saved,[]);
 sessions=[];
 const started=await mineRoute('/wallet/mine/start',PLAYER,body,m,call,rpc,true);
 assert.equal(started?.status,200);assert.equal(saved[5],(await floatKey(m)).address);
 assert.equal(JSON.parse(String(saved[3])).stake_per_round,'10000');
});

Deno.test('custody keys are deterministic, distinct per player and sign verifiably', async () => {
  const a = await custodyKey(master, PLAYER), b = await custodyKey(master, PLAYER);
  const other = await custodyKey(master, '10000000-0000-4000-8000-000000000002');
  assert.equal(a.address, b.address);
  assert.notEqual(a.address, other.address);
  assert.notEqual(a.address, (await floatKey(master)).address);
  const message = new TextEncoder().encode('heroloop');
  const pub = await crypto.subtle.importKey('raw', ab(base58Decode(a.address)), { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify('Ed25519', pub, ab(await a.sign(message)), message), true);
  await assert.rejects(deriveMineKey(new Uint8Array(31), 'x'));
});

Deno.test('policy tiers and system transfer encoding', () => {
  assert.equal(minePolicy('0.1')?.stake_per_round, '100000000');
  assert.equal(minePolicy('0.1')?.fee_bps, '0');
  assert.equal(minePolicy('2'), null);
  const ix = transferInstruction('11111111111111111111111111111112', '11111111111111111111111111111113', 5n);
  assert.deepEqual([...ix.data], [2, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]);
});

Deno.test('custody delta binds signer and program set, keeps failed-transaction fees', async () => {
  const key = await custodyKey(master, PLAYER);
  const tx = { meta: { err: { InstructionError: [1, 'Custom'] }, preBalances: [100_000, 0], postBalances: [95_000, 0] },
    transaction: { signatures: ['S'], message: { accountKeys: [key.address, ORE_PROGRAM, COMPUTE_BUDGET_PROGRAM],
      instructions: [{ programIdIndex: 2 }, { programIdIndex: 1 }] } } };
  assert.equal(custodyDelta(tx, 'S', key.address), -5_000n);
  assert.throws(() => custodyDelta(tx, 'T', key.address));
  const foreign = structuredClone(tx);
  foreign.transaction.message.accountKeys[2] = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  assert.throws(() => custodyDelta(foreign, 'S', key.address));
});

function fakeChain(options: { custody: bigint; signatureStatus?: unknown; tx?: unknown }) {
  const board = new Uint8Array(40);
  board[0] = 105;
  const dv = new DataView(board.buffer);
  dv.setBigUint64(8, 50n, true);
  dv.setBigUint64(16, 1_000n, true);
  dv.setBigUint64(24, 1_240n, true);
  const sent: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === 'getAccountInfo') {
      return { value: params[0] === ORE_BOARD ? { owner: ORE_PROGRAM, data: [b64(board), 'base64'] } : null };
    }
    if (method === 'getSlot') return 1_100;
    if (method === 'getBalance') return { value: Number(options.custody) };
    if (method === 'getLatestBlockhash') return { value: { blockhash: ORE_BOARD, lastValidBlockHeight: 1200 } };
    if (method === 'sendTransaction') { sent.push(String(params[0])); return 'sig'; }
    if (method === 'getSignatureStatuses') return { value: [options.signatureStatus ?? null] };
    if (method === 'getTransaction') return options.tx ?? null;
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, sent };
}

Deno.test('tick persists the round before sending exactly one deploy', async () => {
  const key = await custodyKey(master, PLAYER);
  const calls: [string, unknown[]][] = [];
  const session = { id: 'aaaaaaaa-0000-4000-8000-000000000001', player_id: PLAYER, status: 'active',
    policy: minePolicy('0.00001'), custody_address: key.address, reserved_minor: '100000000', spent_minor: '0', completed: 0,
    round_limit: 6, round_cost_minor: '14510000', last_ore_round_id: null, pending: null };
  const chain = fakeChain({ custody: 100_000_000n });
  await mineTick({ master, rpc: chain.rpc, call: async (sql, args) => {
    calls.push([sql, args]);
    return sql.includes('mine_runner_work') ? { sessions: [session] } : {};
  } });
  const prepare = calls.find(([sql]) => sql.includes('mine_round_prepare'));
  assert.ok(prepare);
  assert.equal(prepare![1][2], '50');
  assert.equal(chain.sent.length, 1);
  void minerAddress;
});

Deno.test('finalized pending round settles its exact cost; unfunded custody is funded once', async () => {
  const key = await custodyKey(master, PLAYER);
  const calls: [string, unknown[]][] = [];
  let funding:Record<string,unknown>={};
  const base = { id: 'aaaaaaaa-0000-4000-8000-000000000002', player_id: PLAYER, status: 'active', policy: minePolicy('0.00001'),
    custody_address: key.address, reserved_minor: '100000000', spent_minor: '0', completed: 0, round_limit: 6,
    round_cost_minor: '14510000', last_ore_round_id: '49' };
  const tx = { meta: { err: null, preBalances: [100_000_000, 0], postBalances: [85_505_000, 0] },
    transaction: { signatures: ['P'], message: { accountKeys: [key.address, ORE_PROGRAM], instructions: [{ programIdIndex: 1 }] } } };
  const chain = fakeChain({ custody: 0n, signatureStatus: { confirmationStatus: 'finalized' }, tx });
  const originalRpc=chain.rpc;
  const call = async (sql: string, args: unknown[]) => {
    calls.push([sql, args]);
    if(sql.includes('mine_action_prepare')){funding={id:args[0],signature:args[4],wire:args[5],last_valid_height:args[6],status:'signed'};return funding;}
    if(sql.includes('mine_action_get'))return funding;
    return sql.includes('mine_runner_work') ? { sessions: [
      { ...base, pending: { id: 'bbbbbbbb-0000-4000-8000-000000000001', ore_round_id: '49', submitted_signature: 'P' } },
      { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000003', pending: null },
    ] } : {};
  };
  const fundingRpc=async(method:string,params:unknown[])=>{
    if(method==='getTransaction'&&params[0]===funding.signature)return null;
    if(method==='getSignatureStatuses'&&(params[0] as unknown[])[0]===funding.signature)return {value:[null]};
    if(method==='getBlockHeight')return 1000;
    if(method==='sendTransaction'){chain.sent.push(String(params[0]));return funding.signature;}
    return originalRpc(method,params);
  };
  await mineTick({ master, rpc: fundingRpc, call });
  const settle = calls.find(([sql]) => sql.includes('mine_round_settle'));
  assert.deepEqual(settle![1].slice(1), ['14495000', 'P']);
  assert.equal(chain.sent.length, 1, 'one funding transfer');
  await mineTick({ master, rpc: async(method,params)=>method==='getSignatureStatuses'&&(params[0] as unknown[])[0]===funding.signature?{value:[{confirmationStatus:'confirmed'}]}:fundingRpc(method,params), call });
  assert.equal(chain.sent.length, 1, 'funding reuses its pending signature');
});

Deno.test('chosen squares set a mask and a per-square stake', () => {
  const policy = minePolicy('0.1', [0, 6, 24])!;
  assert.equal(policy.square_mask, String(1 + 64 + (1 << 24)));
  assert.equal(policy.stake_per_round, '300000000');
  assert.deepEqual(sessionSquares(policy), { squares: [0, 6, 24], perSquare: 100_000_000n });
  assert.deepEqual(sessionSquares(minePolicy('0.00001')!).squares.length, 25);
  for (const bad of [[], [25], [1, 1], ['3'], 'x']) assert.equal(minePolicy('0.1', bad), null);
});

Deno.test('Mine start retains the global exposure gate and requires ORE activation', async () => {
  const {mineRoute,MINE_MAX_IN_FLIGHT}=await import('./mine_service.ts');
  const {MINE_TERMS_VERSION}=await import('./mine_runner.ts');
  const calls:string[]=[];
  const call=async(sql:string)=>{calls.push(sql);return {sessions:[{reserved_minor:MINE_MAX_IN_FLIGHT.toString(),spent_minor:'0'}]};};
  const body={tier:'0.00001',rounds:1,session_id:'aaaaaaaa-0000-4000-8000-000000000001'};
  const rpc=async()=>{throw new Error('capacity must refuse before RPC or mutation');};
  const unavailable=await mineRoute('/wallet/mine/start',PLAYER,body,master,call,rpc,false);
  assert.equal(unavailable?.status,409);assert.equal(calls.length,0);
  const full=await mineRoute('/wallet/mine/start',PLAYER,body,master,call,rpc,true);
  assert.equal((await full!.json()).code,'mining_capacity_reached');
  assert.equal(calls.length,1);assert.ok(calls[0].includes('mine_runner_work'));
  const oldTerms=await mineRoute('/wallet/mine/accept-terms',PLAYER,{version:'2026-10-03'},master,call,rpc,true);
  assert.equal(oldTerms?.status,400);
  let acceptedVersion:unknown;
  const newTerms=await mineRoute('/wallet/mine/accept-terms',PLAYER,{version:MINE_TERMS_VERSION},master,async(_sql,args)=>{acceptedVersion=args[1];return {};},rpc,true);
  assert.equal(newTerms?.status,200);assert.equal(acceptedVersion,MINE_TERMS_VERSION);
});

Deno.test('pending deploys reuse stored bytes and require actual expiry before releasing reserve', async () => {
  const key=await custodyKey(master,PLAYER);
  for(const [oreRound,height,known,expectedSends,expectedSettle] of [
    [50,1100,false,1,false],[48,1100,false,0,false],[48,1201,false,0,true],[50,1201,false,0,false],[48,1201,true,0,false],
  ] as const){
    const chain=fakeChain({custody:0n,signatureStatus:known?{confirmationStatus:'confirmed'}:null});
    const calls:[string,unknown[]][]=[];
    const session={id:'aaaaaaaa-0000-4000-8000-000000000009',player_id:PLAYER,custody_address:key.address,
      pending:{id:'bbbbbbbb-0000-4000-8000-000000000009',ore_round_id:String(oreRound),submitted_signature:'saved-signature',submitted_wire:'saved-wire',last_valid_height:'1200'}};
    const rpc=async(method:string,params:unknown[])=>{
      if(method==='getLatestBlockhash')throw new Error('pending deploy must never be resigned');
      if(method==='getBlockHeight')return height;
      return chain.rpc(method,params);
    };
    const errors:string[]=[];
    await mineTick({master,rpc,call:async(sql,args)=>{calls.push([sql,args]);return sql.includes('mine_runner_work')?{sessions:[session]}:{};},log:(_event,details)=>{errors.push(String(details?.error));}});
    assert.deepEqual(errors,[]);assert.equal(chain.sent.length,expectedSends);
    if(expectedSends)assert.equal(chain.sent[0],'saved-wire');
    const settled=calls.find(([sql])=>sql.includes('mine_round_settle'));
    assert.equal(!!settled,expectedSettle);
    if(settled)assert.deepEqual(settled[1].slice(1),['0','saved-signature']);
  }
});

Deno.test('tiny per-shaft stake retains fee reserve and preserves old-page stakes and rejects forged tiers', () => {
 const policy=minePolicy('0.00001',[0,24])!;
 assert.equal(policy.stake_per_round,'20000');
 assert.deepEqual(sessionSquares(policy),{squares:[0,24],perSquare:10000n});
 assert.equal(BigInt(String(policy.stake_per_round))+BigInt(String(policy.network_per_round))+BigInt(String(policy.protocol_per_round)),4530000n);
 assert.equal(minePolicy('0.01',[0])?.stake_per_round,'10000000');
 for(const tier of ['0.000001','0.000010','1e-5','-0.00001'])assert.equal(minePolicy(tier,[0]),null);
});

Deno.test('tiny start reserves server-derived costs and status discloses the same caps', async () => {
 const {mineRoute}=await import('./mine_service.ts');
 const m=await sharedMaster();let saved:unknown[]=[];
 const call=async(sql:string,args:unknown[])=>{
   if(sql.includes('mine_runner_work'))return {sessions:[]};
   if(sql.includes('mine_start'))saved=args;
   return {};
 };
 const rpc=async()=>({value:85000000});
 const response=await mineRoute('/wallet/mine/start',PLAYER,{tier:'0.00001',rounds:1,squares:[0],session_id:'aaaaaaaa-0000-4000-8000-000000000001',amount:'1'},m,call,rpc,true);
 assert.equal(response?.status,200);assert.equal(saved[2],'4520000');
 const status=await mineRoute('/wallet/mine/status',PLAYER,{},m,call,rpc,true);
 const result=(await status!.json()).result;
 assert.equal(result.network_per_round_minor,'10000');
 assert.equal(result.protocol_per_round_minor,'4500000');
 assert.deepEqual(result.tiers,['0.00001','0.1','1']);
});
