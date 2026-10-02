import assert from 'node:assert/strict';
import test from 'node:test';
import { skrListingPriceCents } from '../src/game/skrListingPrice';

test('SKR listing input converts to server cents without losing the price step', () => {
  assert.equal(skrListingPriceCents('5', '20000'), 10);
  assert.equal(skrListingPriceCents('5.000001', '20000'), 11);
  assert.equal(skrListingPriceCents('0.000001', '20000'), 1);
  assert.equal(skrListingPriceCents('5', '40000'), 20);
  assert.equal(skrListingPriceCents('500000000', '20000'), 1000000000);
  assert.equal(skrListingPriceCents('500000000.000001', '20000'), 0);
});

test('missing or malformed SKR prices and rates cannot create a listing price', () => {
  for (const value of ['', '0', '-1', '1e3', 'NaN', '1.0000001', '1,5', '1000000000']) {
    assert.equal(skrListingPriceCents(value, '20000'), 0);
  }
  for (const rate of [null, '0', '-1', 'NaN', '1.5']) {
    assert.equal(skrListingPriceCents('5', rate), 0);
  }
  assert.equal(skrListingPriceCents('999999999', '999999999999999999'), 0);
});
