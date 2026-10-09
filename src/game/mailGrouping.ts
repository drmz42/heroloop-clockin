import type { MailAttachment, MailEntry } from './useGame';

// Presentation only: keep every original delivery and attachment for server claims.
function rewardKey(reward: MailAttachment): string | null {
  switch (reward.kind) {
    case 'item': return null;
    case 'hero': return JSON.stringify([reward.kind, reward.claimed, reward.heroId, reward.title, reward.level, reward.stars, reward.bound]);
    case 'chest': return JSON.stringify([reward.kind, reward.claimed, reward.chest.stage, !!reward.chest.boss, !!reward.chest.tutorial]);
    case 'gold': return JSON.stringify([reward.kind, reward.claimed, reward.amount]);
    case 'resource': return JSON.stringify([reward.kind, reward.claimed, reward.resourceId, reward.title, reward.amount]);
  }
}

export interface MailGroup {
  id: string;
  entries: MailEntry[];
}

export function groupMailEntries(entries: readonly MailEntry[]): MailGroup[] {
  const groups: MailGroup[] = [];
  const byReward = new Map<string, MailGroup>();
  for (const entry of entries) {
    // Equipment keeps its individual identity, stats and purchase provenance.
    const rewards = entry.kind === 'letter' ? entry.attachments.map(rewardKey) : [];
    const key = entry.kind === 'letter' && rewards.length > 0 && !rewards.includes(null)
      ? JSON.stringify([entry.source, entry.sender, entry.title, entry.body, entry.claimed, rewards.sort()]) : null;
    const existing = key === null ? undefined : byReward.get(key);
    if (existing) existing.entries.push(entry);
    else {
      const group = { id: entry.id, entries: [entry] };
      groups.push(group);
      if (key !== null) byReward.set(key, group);
    }
  }
  return groups;
}
