export const COMBAT_TIMELINE_VERSION = 1;
export const MAX_COMBAT_TIMELINE_EVENTS = 4096;

export function serializeCombatTimeline(events, autoPotions = []) {
  const ordered = [
    ...events.map((event, index) => ({ elapsedMs: event.elapsedMs, phase: 0, index, event })),
    ...autoPotions.map((potion, index) => ({
      elapsedMs: potion.elapsed_ms,
      phase: 1,
      index,
      event: { kind: 'potion', targetUid: potion.hero_uid, amount: potion.hp_restore },
    })),
  ].sort((left, right) => left.elapsedMs - right.elapsedMs || left.phase - right.phase || left.index - right.index);
  if (ordered.length > MAX_COMBAT_TIMELINE_EVENTS) throw new Error('normal_combat_timeline_too_large');
  return ordered.map(({ elapsedMs, event }, sequence) => ({
    sequence,
    elapsed_ms: elapsedMs,
    kind: event.kind,
    source_uid: event.sourceUid ?? event.attackerUid ?? (event.kind === 'heal' || event.kind === 'potion' ? event.targetUid : undefined),
    target_uid: event.targetUid,
    amount: event.amount,
    critical: event.kind === 'damage' ? event.critical : undefined,
    effect_id: event.kind === 'effect' ? event.effectId : undefined,
    duration_ms: event.kind === 'effect' ? event.durationMs : undefined,
  }));
}

export function parseCombatTimeline(value, unitIds, maxElapsedMs) {
  if (!Array.isArray(value) || value.length > MAX_COMBAT_TIMELINE_EVENTS) return null;
  const knownUnits = unitIds instanceof Set ? unitIds : new Set(unitIds);
  let previousElapsed = -1;
  const parsed = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== 'object' || entry.sequence !== index) return null;
    const elapsedMs = Number(entry.elapsed_ms);
    const amount = entry.amount === undefined ? undefined : Number(entry.amount);
    const kind = entry.kind;
    const targetUid = entry.target_uid;
    const sourceUid = entry.source_uid;
    const durationMs = entry.duration_ms === undefined ? undefined : Number(entry.duration_ms);
    if (!['damage', 'miss', 'heal', 'effect', 'potion'].includes(kind)
      || !Number.isSafeInteger(elapsedMs) || elapsedMs < previousElapsed || elapsedMs > maxElapsedMs
      || typeof targetUid !== 'string' || !knownUnits.has(targetUid)
      || typeof sourceUid !== 'string' || !knownUnits.has(sourceUid)
      || (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0))
      || (kind === 'damage' && (amount === undefined || typeof entry.critical !== 'boolean'))
      || (kind === 'effect' && typeof entry.effect_id !== 'string')
      || (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0))) return null;
    previousElapsed = elapsedMs;
    parsed.push({
      sequence: index,
      elapsedMs,
      kind,
      sourceUid,
      targetUid,
      amount,
      critical: kind === 'damage' ? entry.critical : false,
      effectId: kind === 'effect' ? entry.effect_id : undefined,
      durationMs: kind === 'effect' ? durationMs : undefined,
    });
  }
  return parsed;
}
