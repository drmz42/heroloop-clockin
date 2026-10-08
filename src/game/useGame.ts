import { seekerXpReward } from '../../managed/functions/player-sync/seeker-progression.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isolatedHackathon } from './editionStorage';
import { commitSkrPurchase } from './seekerWallet';
import { skrError } from './skrPurchase';
import { automaticHealingConfig } from '../../managed/functions/player-sync/automatic-healing.mjs';
import { flushSync } from 'react-dom';
import type { GameState, OwnedHero, CombatUnit, FloatingNumber, ItemSlot, OwnedItem, PotionTier, DailyQuest, TrainingBoostKey } from '@/game/types';
import {
  loadState, normalizeState, makeInitialState, starUpCost,
  MAX_TEAM, BASE_HERO_CAPACITY, MAX_HERO_CAPACITY, HERO_CAPACITY_STEP, MAX_HERO_STARS, inventoryCapacity, MAX_CHESTS, RESPAWN_TIME_MS, ROTATING_REFRESH_MS,
  awardSeekerXp, gameDayKey,
  TRAINING_SLOT_COSTS, TRAINING_BOOST_COSTS,
