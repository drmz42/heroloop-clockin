import assert from 'node:assert/strict';
import { base58Decode } from './chain.ts';
import { ORE_BOARD, ORE_PROGRAM, COMPUTE_BUDGET_PROGRAM, minerAddress } from './ore.ts';
import { custodyDelta, custodyKey, deriveMineKey, floatKey, mineTick, minePolicy, sessionSquares, transferInstruction } from './mine_runner.ts';

const master = new Uint8Array(32).fill(7);
const PLAYER = '10000000-0000-4000-8000-000000000001';
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

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
    if (method === 'getLatestBlockhash') return { value: { blockhash: ORE_BOARD } };
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
    policy: minePolicy('0.01'), custody_address: key.address, reserved_minor: '100000000', spent_minor: '0', completed: 0,
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
  const base = { id: 'aaaaaaaa-0000-4000-8000-000000000002', player_id: PLAYER, status: 'active', policy: minePolicy('0.01'),
    custody_address: key.address, reserved_minor: '100000000', spent_minor: '0', completed: 0, round_limit: 6,
    round_cost_minor: '14510000', last_ore_round_id: '49' };
  const tx = { meta: { err: null, preBalances: [100_000_000, 0], postBalances: [85_505_000, 0] },
    transaction: { signatures: ['P'], message: { accountKeys: [key.address, ORE_PROGRAM], instructions: [{ programIdIndex: 1 }] } } };
  const chain = fakeChain({ custody: 0n, signatureStatus: { confirmationStatus: 'finalized' }, tx });
  const call = async (sql: string, args: unknown[]) => {
    calls.push([sql, args]);
    return sql.includes('mine_runner_work') ? { sessions: [
      { ...base, pending: { id: 'bbbbbbbb-0000-4000-8000-000000000001', ore_round_id: '49', submitted_signature: 'P' } },
      { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000003', pending: null },
    ] } : {};
  };
  await mineTick({ master, rpc: chain.rpc, call });
  const settle = calls.find(([sql]) => sql.includes('mine_round_settle'));
  assert.deepEqual(settle![1].slice(1), ['14495000', 'P']);
  assert.equal(chain.sent.length, 1, 'one funding transfer');
  await mineTick({ master, rpc: chain.rpc, call });
  assert.equal(chain.sent.length, 1, 'funding is not repeated while in flight');
});

Deno.test('chosen squares set a mask and a per-square stake', () => {
  const policy = minePolicy('0.1', [0, 6, 24])!;
  assert.equal(policy.square_mask, String(1 + 64 + (1 << 24)));
  assert.equal(policy.stake_per_round, '300000000');
  assert.deepEqual(sessionSquares(policy), { squares: [0, 6, 24], perSquare: 100_000_000n });
  assert.deepEqual(sessionSquares(minePolicy('0.01')!).squares.length, 25);
  for (const bad of [[], [25], [1, 1], ['3'], 'x']) assert.equal(minePolicy('0.1', bad), null);
});
