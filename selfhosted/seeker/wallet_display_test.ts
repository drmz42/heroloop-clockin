import { deepStrictEqual as assertEquals, throws as assertThrows } from 'node:assert/strict';
import { externalBalances } from './wallet_display.ts';
const limits = { SKR: 10_000_000_000n, SOL: 2_000_000_000n };
const token = (amount: string, state = 'initialized') => ({ account: { data: { parsed: { info: { state, tokenAmount: { amount, decimals: 6 } } } } } });
Deno.test('wallet MAX preserves atomic precision, fees, existing caps and one transfer account', () => {
  assertEquals(externalBalances({ value: 2000005001 }, { value: [token('1000001'), token('2000002'), token('3000003','frozen')] }, limits), {
    external_balances: { SKR: '6000006', SOL: '2000005001' }, max_deposit_balances: { SKR: '2000002', SOL: '2000000000' },
  });
  assertEquals(externalBalances({ value: 4999 }, { value: [] }, limits).max_deposit_balances, { SKR: '0', SOL: '0' });
  assertEquals(externalBalances({ value: 15001 }, { value: [token('10000000001')] }, limits).max_deposit_balances, { SKR: '10000000000', SOL: '10001' });
});
Deno.test('unreadable chain balances do not turn into a zero or rounded MAX', () => {
  for (const value of [null, {value: -1}, {value: Number.MAX_SAFE_INTEGER + 1}]) assertThrows(() => externalBalances(value,{value:[]},limits));
  assertThrows(() => externalBalances({value:10000},{value:[token('1.5')]},limits));
});
