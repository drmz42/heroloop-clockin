import assert from 'node:assert/strict';
import { base58Decode, base58Encode } from './chain.ts';
import {
  checkpointInstruction, claimSolInstruction, compileMessage, decodeBoard, decodeMiner, deployInstruction,
  findProgramAddress, isOnCurve, ORE_BOARD, ORE_CONFIG, ORE_ENTROPY_PROGRAM, ORE_ENTROPY_VAR, ORE_PROGRAM,
  ORE_TREASURY, OreError, serializeTransaction, squareMask, verifyOreReceipt, winningSquare,
} from './ore.ts';

const text = (s: string) => new TextEncoder().encode(s);
const AUTHORITY = 'HBUh9g46wk2X89CvaNN15UmsznP59rh6od1h8JwYAopk';

Deno.test('PDA derivation reproduces the pinned ORE and entropy addresses', async () => {
  assert.equal(await findProgramAddress([text('board')], ORE_PROGRAM), ORE_BOARD);
  assert.equal(await findProgramAddress([text('config')], ORE_PROGRAM), ORE_CONFIG);
  assert.equal(await findProgramAddress([text('treasury')], ORE_PROGRAM), ORE_TREASURY);
  assert.equal(await findProgramAddress([text('var'), base58Decode(ORE_BOARD), new Uint8Array(8)], ORE_ENTROPY_PROGRAM),
    ORE_ENTROPY_VAR);
  // A real wallet key is on the curve; a PDA never is.
  assert.equal(isOnCurve(base58Decode(AUTHORITY)), true);
  assert.equal(isOnCurve(base58Decode(ORE_BOARD)), false);
});

Deno.test('deploy, checkpoint and claim instructions match the ORE SDK layout', async () => {
  const deploy = await deployInstruction(AUTHORITY, 427253n, 10_000_000n, [0, 24]);
  assert.deepEqual([...deploy.data], [6, 0x80, 0x96, 0x98, 0, 0, 0, 0, 0, 1, 0, 0, 1]);
  assert.equal(deploy.accounts.length, 12);
  assert.equal(deploy.accounts[0].signer && deploy.accounts[0].address === AUTHORITY, true);
  assert.equal(deploy.accounts[10].address, ORE_ENTROPY_VAR);
  assert.deepEqual([...(await checkpointInstruction(AUTHORITY, 1n)).data], [2]);
  assert.deepEqual([...(await claimSolInstruction(AUTHORITY)).data], [3]);
  assert.equal(squareMask([3]), 8);
  for (const bad of [[], [25], [-1], [1, 1], [0.5]]) assert.throws(() => squareMask(bad), OreError);
  await assert.rejects(deployInstruction(AUTHORITY, 1n, 0n, [0]), OreError);
});

Deno.test('legacy message orders signer, writable and readonly keys', async () => {
  const ix = await claimSolInstruction(AUTHORITY);
  const message = compileMessage(AUTHORITY, [ix], ORE_BOARD);
  // header: 1 signer, 0 readonly signed, 2 readonly unsigned (system + ORE program)
  assert.deepEqual([...message.slice(0, 4)], [1, 0, 2, 5]);
  assert.equal(base58Encode(message.slice(4, 36)), AUTHORITY);
  const tx = serializeTransaction(new Uint8Array(64), message);
  assert.equal(tx.length, 1 + 64 + message.length);
});

Deno.test('account decoders reject foreign data and read fields', () => {
  const board = new Uint8Array(40);
  board[0] = 105;
  new DataView(board.buffer).setBigUint64(8, 427253n, true);
  assert.equal(decodeBoard(board).roundId, 427253n);
  assert.throws(() => decodeBoard(new Uint8Array(40)), OreError);
  const miner = new Uint8Array(752);
  miner[0] = 103;
  miner.set(base58Decode(AUTHORITY), 8);
  new DataView(miner.buffer).setBigUint64(688, 5n, true);
  assert.equal(decodeMiner(miner).authority, AUTHORITY);
  assert.equal(decodeMiner(miner).rewardsSol, 5n);
});

Deno.test('receipt verification binds signer, program set and balances', () => {
  const sig = 'S'.repeat(64);
  const tx = {
    slot: 9, meta: { err: null, fee: 5000, preBalances: [1_000_000, 0], postBalances: [985_000, 0] },
    transaction: { signatures: [sig], message: { accountKeys: [AUTHORITY, ORE_PROGRAM], header: { numRequiredSignatures: 1 },
      instructions: [{ programIdIndex: 1 }] } },
  };
  assert.equal(verifyOreReceipt(tx, sig, AUTHORITY).lamportDelta, -15_000n);
  assert.throws(() => verifyOreReceipt({ ...tx, meta: { ...tx.meta, err: { x: 1 } } }, sig, AUTHORITY), OreError);
  assert.throws(() => verifyOreReceipt(tx, 'T'.repeat(64), AUTHORITY), OreError);
  const foreign = structuredClone(tx);
  foreign.transaction.message.accountKeys[1] = '11111111111111111111111111111111';
  assert.throws(() => verifyOreReceipt(foreign, sig, AUTHORITY), OreError);
  assert.throws(() => verifyOreReceipt(null, sig, AUTHORITY), OreError);
});

Deno.test('winning square follows the ORE xor-fold of the revealed hash', () => {
  assert.equal(winningSquare(new Uint8Array(32)), null);
  assert.equal(winningSquare(new Uint8Array(32).fill(255)), null);
  const hash = new Uint8Array(32);
  hash[0] = 30; // r1 = 30, others 0 -> 30 % 25
  assert.equal(winningSquare(hash), 5);
});
