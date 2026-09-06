export const COMBAT_EFFECTS_V2_UI_VERSION = 'combat-effects-v2-team-contributions-candidate-2026.09.06-v1';
export const COMBAT_EFFECTS_V2_UI_ACTIVE = false;

export const COMBAT_EFFECTS_V2_PREVIEW = Object.freeze({
  knight: {
    core: { id: 'core.warrior.bulwark', name: 'Bulwark', description: '+15% maximum HP; DEF mitigation cap increases to 60%.' },
    team: { id: 'team.warrior.guardian-aegis', name: 'Guardian Aegis', capability: 'Protection', description: 'Every 10s, shields the living ally with the lowest HP percentage for 6% of this Warrior’s maximum HP, for up to 5s.' },
  },
  shepherd: {
    core: { id: 'core.mage.arcane-echo', name: 'Arcane Echo', description: 'Every fifth landed hit deals an extra 50% of that hit, inheriting its Critical result without triggering another Echo.' },
    team: { id: 'team.mage.arcane-mark', name: 'Arcane Mark', capability: 'Focus', description: 'Arcane Echo marks its target for 4s; other allies deal 4% more damage to it.' },
  },
  assassin: {
    core: { id: 'core.assassin.predator', name: 'Predator', description: '+5 percentage points Critical Chance; retains 5% base Dodge.' },
    team: { id: 'team.assassin.expose', name: 'Expose', capability: 'Armour Break', description: 'The first Critical hit per 6s exposes its target for 4s; other allies ignore 6% of its DEF.' },
  },
  druid: {
    core: { id: 'core.druid.wild-growth', name: 'Wild Growth', description: '+10% maximum HP.' },
    team: { id: 'team.druid.wild-growth-heal', name: 'Wild Growth Heal', capability: 'Healing', description: 'Every 3s, heals every living ally for 1.2% of that ally’s maximum HP.' },
  },
  archer: {
    core: { id: 'core.crossbowman.deadeye', name: 'Deadeye', description: '+8% Attack Speed and +25 percentage points Critical Damage.' },
    team: { id: 'team.crossbowman.suppressing-fire', name: 'Suppressing Fire', capability: 'Suppression', description: 'Every fifth landed hit reduces its target’s Attack Speed by 8% for 4s.' },
  },
});
