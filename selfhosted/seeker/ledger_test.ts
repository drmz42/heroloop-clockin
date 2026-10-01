import assert from 'node:assert/strict';
import { skrLegs, skrMinor } from './ledger.ts';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
Deno.test('SKR amount accepts exact atomic units, rejects float/exponent/overflow', () => {
  assert.equal(skrMinor('0.000001'), '1');
  assert.equal(skrMinor('123.456789'), '123456789');
  assert.equal(skrMinor('18446744073709.551615'), '18446744073709551615');
  for (const value of ['0','-1','1e3','NaN','1.0000001','01','18446744073709.551616']) {
    assert.throws(() => skrMinor(value));
  }
});
Deno.test('balanced canonical legs reject duplicates, unknown fields and numeric amounts', () => {
  const legs = [{ account_id: b, delta_minor: '20' }, { account_id: a, delta_minor: '-20' }];
  assert.deepEqual(skrLegs(legs), [...legs].reverse());
  for (const value of [null, [], [legs[0]], [legs[0], legs[0]],
    [{ ...legs[0], delta_minor: '21' }, legs[1]],
    [{ ...legs[0], delta_minor: 20 }, legs[1]],
    [{ ...legs[0], delta_minor: '020' }, legs[1]],
    [{ ...legs[0], forged: true }, legs[1]],
    [{ ...legs[0], account_id: 'other-player' }, legs[1]]]) {
    assert.throws(() => skrLegs(value));
  }
});
