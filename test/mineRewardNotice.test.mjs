import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/game/seekerMine.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } });
const { MINE_STAKE_TIERS, observeMineRewards } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('opening historical rewards is quiet, then exact net increases notify once', () => {
  const baseline = observeMineRewards(null, [{ id: 'mine', credited_ore_minor: '100000000001' }]);
  assert.equal(baseline.notice, null);
  const fresh = observeMineRewards(baseline.seen, [{ id: 'mine', credited_ore_minor: '100000000002' }]);
  assert.deepEqual(fresh.notice, { sessionId: 'mine', totalMinor: '100000000002', addedMinor: '1' });
  assert.equal(observeMineRewards(fresh.seen, [{ id: 'mine', credited_ore_minor: '100000000002' }]).notice, null);
});

test('new sessions notify after initialization, but unconfirmed or malformed amounts never do', () => {
  const baseline = observeMineRewards(null, []);
  for (const credited_ore_minor of [undefined, '0', '-1', '1.1', 'NaN']) {
    assert.equal(observeMineRewards(baseline.seen, [{ id: 'mine', credited_ore_minor }]).notice, null);
  }
  assert.equal(observeMineRewards(baseline.seen, [{ id: 'mine', credited_ore_minor: '1' }]).notice?.addedMinor, '1');
});

test('stale snapshots and duplicate session entries do not replay an observed reward', () => {
  const first = observeMineRewards({}, [{ id: 'mine', credited_ore_minor: '100' }]);
  const stale = observeMineRewards(first.seen, [{ id: 'mine', credited_ore_minor: '1' }]);
  assert.equal(stale.seen.mine, '100');
  assert.equal(observeMineRewards(stale.seen, [{ id: 'mine', credited_ore_minor: '100' }]).notice, null);
  const duplicate = observeMineRewards(stale.seen, [{ id: 'mine', credited_ore_minor: '101' }, { id: 'mine', credited_ore_minor: '101' }]);
  assert.equal(duplicate.notice?.addedMinor, '1');
  assert.equal(MINE_STAKE_TIERS[0], '0.00001');
});
