// Run only with synthetic JSON lines emitted by boost_fixture.sql on stdin.
import assert from 'node:assert/strict';
import { evaluateSkrBoost, type SkrBoostSnapshot } from './boost.ts';

const input = await new Response(Deno.stdin.readable).text();
const expectedLabels = ['deposit', 'quoted', 'charged', 'committed', 'replay', 'refunded',
  'gacha', 'market', 'foreign-player', 'reserved', 'released'];
const labels: string[] = [];
for (const line of input.trim().split('\n')) {
  const row = JSON.parse(line) as { label: string; snapshot: SkrBoostSnapshot; spent: string; holding: boolean };
  labels.push(row.label);
  const now = Date.parse(row.snapshot.rate!.observed_at);
  const result = evaluateSkrBoost(row.snapshot, now);
  assert.equal(result.spend.usd_cents, row.spent, `${row.label}: spending`);
  assert.equal(result.spend.complete, BigInt(row.spent) >= 1000n, `${row.label}: spend eligibility`);
  assert.equal(result.hold.complete, row.holding, `${row.label}: holding`);
  assert.equal(result.activation_enabled, false);
  for (const rate of [null, { ...row.snapshot.rate!, observed_at: new Date(now - 60001).toISOString() }]) {
    const stale = evaluateSkrBoost({ ...row.snapshot, rate }, now);
    assert.equal(stale.spend.usd_cents, row.spent);
    assert.equal(stale.hold.complete, false);
  }
}
assert.deepEqual(labels, expectedLabels, 'all SQL scenarios must reach the evaluator');
console.log(`BOOST MAX SQL-to-evaluator: ${labels.length} scenarios passed; activation disabled`);
