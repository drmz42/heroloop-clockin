import assert from 'node:assert/strict';
import { base58Decode, base58Encode, TOKEN_PROGRAM } from './chain.ts';
import {
  checkpointInstruction, claimSolInstruction, compileMessage, decodeBoard, decodeMiner, deployInstruction,
  findProgramAddress, isOnCurve, ORE_BOARD, ORE_CONFIG, ORE_ENTROPY_PROGRAM, ORE_ENTROPY_VAR, ORE_PROGRAM,
  ORE_TREASURY, ORE_MINT, ORE_DECIMALS, ORE_ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM,
  claimOreInstruction, oreTokenAddress, OreError, serializeTransaction, squareMask, verifyOreReceipt,
  verifyOreClaimReceipt, winningSquare,
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

Deno.test('ORE claim matches pinned SDK account order and 10000-bps encoding', async () => {
  // Independent Solana SDK vectors generated with solders.Pubkey.find_program_address.
  assert.equal(await oreTokenAddress(AUTHORITY), '3Ag5aesdDawsCWP32YqZN2NB2eUoH5e8UKcgP9j4arFX');
  assert.equal(await oreTokenAddress(ORE_TREASURY), 'GwZS8yBuPPkPgY4uh7eEhHN5EEdpkf7EBZ1za6nuP3wF');
  const ix = await claimOreInstruction(AUTHORITY);
  assert.deepEqual([...ix.data], [4, 16, 39, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ix.accounts.map(a => a.address), [AUTHORITY, ORE_BOARD,
    await findProgramAddress([text('miner'), base58Decode(AUTHORITY)], ORE_PROGRAM), ORE_MINT,
    await oreTokenAddress(AUTHORITY), ORE_TREASURY, await oreTokenAddress(ORE_TREASURY),
    '11111111111111111111111111111111', TOKEN_PROGRAM, ORE_ASSOCIATED_TOKEN_PROGRAM, ORE_PROGRAM]);
  assert.deepEqual(ix.accounts.map(a => a.signer), [true, ...new Array(10).fill(false)]);
  assert.deepEqual(ix.accounts.map(a => a.writable), [...new Array(7).fill(true), ...new Array(4).fill(false)]);
  for (const bps of [0n, -1n, 10_001n]) await assert.rejects(claimOreInstruction(AUTHORITY, bps), OreError);
  assert.deepEqual([...(await claimOreInstruction(AUTHORITY, 5_000n)).data], [4, 136, 19, 0, 0, 0, 0, 0, 0]);
});

async function oreClaimFixture(created = false) {
  const instruction = await claimOreInstruction(AUTHORITY);
  const signature = 'S'.repeat(64);
  const tokenBalance = (index: number, owner: string, amount: string) => ({
    accountIndex: index, mint: ORE_MINT, owner, programId: TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: ORE_DECIMALS },
  });
  const preBalances = Array(11).fill(1_000_000);
  preBalances[0] = 10_000_000;
  if (created) preBalances[4] = 0;
  const postBalances = [...preBalances];
  postBalances[0] -= created ? 2_044_280 : 5_000;
  if (created) postBalances[4] = 2_039_280;
  const tx = {
    slot: 42,
    meta: { err: null, fee: 5_000, preBalances, postBalances,
      preTokenBalances: [...(created ? [] : [tokenBalance(4, AUTHORITY, '700')]),
        tokenBalance(6, ORE_TREASURY, '100000000000')],
      postTokenBalances: [tokenBalance(4, AUTHORITY, created ? '900' : '1600'),
        tokenBalance(6, ORE_TREASURY, '99999999100')],
    },
    transaction: { signatures: [signature], message: {
      header: { numRequiredSignatures: 1 }, accountKeys: instruction.accounts.map(a => a.address),
      instructions: [{ programIdIndex: 10, accounts: Array.from({ length: 11 }, (_, i) => i),
        data: base58Encode(instruction.data) }],
    } },
  };
  return { tx, signature };
}

Deno.test('ORE claim credits actual net tokens with existing or newly created custody ATA', async () => {
  for (const created of [false, true]) {
    const { tx, signature } = await oreClaimFixture(created);
    const receipt = await verifyOreClaimReceipt(tx, signature, AUTHORITY);
    assert.equal(receipt.amountMinor, 900n, 'credit received amount, not gross rewards');
    assert.equal(receipt.lamportDelta, created ? -2_044_280n : -5_000n, 'track rent and network cost separately');
    assert.equal(receipt.recipient, await oreTokenAddress(AUTHORITY));
    assert.equal(receipt.treasuryTokenAccount, await oreTokenAddress(ORE_TREASURY));
  }
});

Deno.test('ORE claim rejects failed, substituted, repeated or foreign instructions and signers', async () => {
  const { tx, signature } = await oreClaimFixture();
  const mutations: ((v: typeof tx) => void)[] = [
    v => { v.meta.err = { InstructionError: [0, 'Custom'] } as never; },
    v => { v.transaction.signatures[0] = 'T'.repeat(64); },
    v => { v.transaction.signatures.push('T'.repeat(64)); },
    v => { v.transaction.message.header.numRequiredSignatures = 2; },
    v => { v.transaction.message.accountKeys[0] = ORE_TREASURY; },
    v => { v.transaction.message.accountKeys[3] = ORE_BOARD; },
    v => { v.transaction.message.instructions[0].accounts[4] = 6; },
    v => { v.transaction.message.instructions[0].accounts.pop(); },
    v => { v.transaction.message.instructions[0].data = base58Encode(Uint8Array.of(3)); },
    v => { v.transaction.message.instructions[0].data = base58Encode(Uint8Array.of(4, 136, 19, 0, 0, 0, 0, 0, 0)); },
    v => { v.transaction.message.instructions.push(structuredClone(v.transaction.message.instructions[0])); },
    v => { v.transaction.message.instructions[0].programIdIndex = 8; },
    v => { v.transaction.message.instructions[0].programIdIndex = 10.5; },
    v => { v.transaction.message.instructions[0].data = 'invalid_0'; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(tx); mutate(invalid);
    await assert.rejects(verifyOreClaimReceipt(invalid, signature, AUTHORITY), OreError);
  }
});

Deno.test('ORE claim rejects missing, duplicate, wrong-mint/owner/precision and unbalanced token receipts', async () => {
  const { tx, signature } = await oreClaimFixture();
  const mutations: ((v: typeof tx) => void)[] = [
    v => { v.meta.preTokenBalances = []; },
    v => { v.meta.postTokenBalances = []; },
    v => { v.meta.postTokenBalances.push(structuredClone(v.meta.postTokenBalances[0])); },
    v => { v.meta.postTokenBalances[0].mint = ORE_BOARD; },
    v => { v.meta.postTokenBalances[0].owner = ORE_TREASURY; },
    v => { v.meta.postTokenBalances[0].programId = ORE_PROGRAM; },
    v => { v.meta.postTokenBalances[0].uiTokenAmount.decimals = 6; },
    v => { v.meta.postTokenBalances[0].uiTokenAmount.amount = '1.6'; },
    v => { v.meta.postTokenBalances[0].uiTokenAmount.amount = '18446744073709551616'; },
    v => { v.meta.postTokenBalances[0].uiTokenAmount.amount = '700'; },
    v => { v.meta.postTokenBalances[1].uiTokenAmount.amount = '99999999101'; },
    v => { v.meta.preTokenBalances[1].owner = AUTHORITY; },
    v => { v.meta.fee = -5_000; },
    v => { v.slot = -1; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(tx); mutate(invalid);
    await assert.rejects(verifyOreClaimReceipt(invalid, signature, AUTHORITY), OreError);
  }
});

Deno.test('ORE claim permits compute budget prefixes but rejects transfer or claim combinations', async () => {
  const { tx, signature } = await oreClaimFixture();
  tx.transaction.message.accountKeys.push(COMPUTE_BUDGET_PROGRAM);
  tx.transaction.message.instructions.unshift({ programIdIndex: 11, accounts: [],
    data: base58Encode(Uint8Array.of(2, 128, 26, 6, 0)) });
  assert.equal((await verifyOreClaimReceipt(tx, signature, AUTHORITY)).amountMinor, 900n);
  tx.transaction.message.instructions[0].accounts = [0];
  await assert.rejects(verifyOreClaimReceipt(tx, signature, AUTHORITY), OreError);
  tx.transaction.message.instructions[0].accounts = [];
  tx.transaction.message.instructions[0].data = base58Encode(Uint8Array.of(2));
  await assert.rejects(verifyOreClaimReceipt(tx, signature, AUTHORITY), OreError);
});
