import { createPortal } from 'react-dom';
import { isolatedHackathon } from '@/game/editionStorage';
import { isAndroidLayout } from '@/platform/platform';
import { useMemo, useState, type CSSProperties } from 'react';
import { Axe, ChevronDown, Clock3, Crosshair, Dumbbell, Info, LockKeyhole, Shield, ShieldCheck, Sparkles, Swords, Target, UserRoundPlus, X } from 'lucide-react';
import { GameSelect } from '@/components/GameSelect';
import { HeroPortrait } from '@/components/HeroPortrait';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { skrPrice, useSkrRate } from '@/game/skrPurchase';
import { CLASS_LABEL, HERO_MAP, RARITY_COLORS, RARITY_INDEX } from '@/game/heroes';
import { buildLocation, latestTokenLocation, teamPower } from '@/game/engine';
import { heroXpForLevel, trainingTokenPenalty, TRAINING_BOOST_COSTS, TRAINING_SLOT_COSTS } from '@/game/state';
import type { HeroClass, TrainingBoostKey } from '@/game/types';
import type { useGame } from '@/game/useGame';
import { groupNumber } from '@/game/numberFormat';
import '@/theme/scene/scene.css';
import { RarityFx } from '@/components/RarityFx';

type Game = ReturnType<typeof useGame>;
type SortKey = 'stars' | 'level' | 'power' | 'rarity' | 'class';

const CLASS_DRILLS: Record<HeroClass, { label: string; Icon: typeof Swords }> = {
  knight: { label: 'Combat Dummy', Icon: Swords },
  archer: { label: 'Target Range', Icon: Crosshair },
  assassin: { label: 'Reflex Posts', Icon: Axe },
  shepherd: { label: 'Guard Drill', Icon: Shield },
  druid: { label: 'Focus Totem', Icon: Sparkles },
};

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'stars', label: 'Stars' }, { id: 'level', label: 'Level' }, { id: 'power', label: 'Power' },
  { id: 'rarity', label: 'Rarity' }, { id: 'class', label: 'Class' },
];
const TRAINING_BOOSTS = [
  { key: '2x-1h', multiplier: 2, hours: 1 },
  { key: '2x-4h', multiplier: 2, hours: 4 },
  { key: '4x-1h', multiplier: 4, hours: 1 },
  { key: '4x-4h', multiplier: 4, hours: 4 },
] as const satisfies ReadonlyArray<{ key: TrainingBoostKey; multiplier: 2 | 4; hours: 1 | 4 }>;

// Seeker prices: the HERO costs at the server's $0.001 HERO quote (50 HERO = 5 cents).
const usdCents = (heroCost: number) => heroCost / 10;
const usdLabel = (cents: number) => `$${(cents / 100).toFixed(cents % 1 ? 3 : 2)}`;
type SkrTrainingOffer = { product: 'training_slot_unlock' | 'training_boost_buy'; params: Record<string, unknown>; title: string; cents: number };

function formatBoostTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function TrainingCampScreen({ game }: { game: Game }) {
  const { state } = game;
  const now = game.presentationNow;
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey>('power');
  const [classFilter, setClassFilter] = useState<'all' | HeroClass>('all');
  const [skrOffer, setSkrOffer] = useState<SkrTrainingOffer | null>(null);
  const skrRate = useSkrRate(isolatedHackathon);
  const skrLabel = (cents: number) => `${usdLabel(cents)} · ${skrRate ? skrPrice(cents, skrRate) : '… SKR'}`;
  const locationId = latestTokenLocation(state.accountLevel, state.highestLocation, state.seekerProgression?.legacyLocationAccess);
  const baseXpPerHour = Math.floor(buildLocation(locationId, 1).xpReward * 300 * 1.6 * .85);
