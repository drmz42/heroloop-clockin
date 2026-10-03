// Read-only mainnet acceptance probe for the ORE adapter: decodes the live board
// and simulates (sigVerify=false, no key, nothing sent) one 0.01 SOL deploy and a
// claim for PAYER. Usage: deno run --allow-net=api.mainnet-beta.solana.com ore_simulate.ts PAYER

import { claimSolInstruction, compileMessage, computeUnitLimitInstruction, decodeBoard, decodeRound, deployInstruction, ORE_BOARD, roundAddress, serializeTransaction } from './ore.ts';
const RPC = 'https://api.mainnet-beta.solana.com';
const rpc = async (method: string, params: unknown[]) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; };
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const board = decodeBoard(b64((await rpc('getAccountInfo', [ORE_BOARD, { encoding: 'base64' }])).value.data[0]));
const round = decodeRound(b64((await rpc('getAccountInfo', [await roundAddress(board.roundId), { encoding: 'base64' }])).value.data[0]));
console.log('round', board.roundId, 'ends', board.endSlot, 'miners', round.totalMiners, 'deployedSq0', round.deployed[0]);
const payer = Deno.args[0];
const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
for (const [label, ixs] of [
  ['deploy 0.01 SOL x1', [computeUnitLimitInstruction(400_000), await deployInstruction(payer, board.roundId, 10_000_000n, [7])]],
  ['claim_sol', [await claimSolInstruction(payer)]],
] as const) {
  const msg = compileMessage(payer, ixs as never, blockhash);
  const tx = serializeTransaction(new Uint8Array(64), msg);
  const res = await rpc('simulateTransaction', [btoa(String.fromCharCode(...tx)), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: [payer] } }]);
  console.log(label, 'err=', JSON.stringify(res.value.err), 'units=', res.value.unitsConsumed, 'payerAfter=', res.value.accounts?.[0]?.lamports);
  console.log((res.value.logs ?? []).filter((l: string) => /deploy|Round|error|failed|Program ore/i.test(l)).slice(0, 8).join('\n'));
}
