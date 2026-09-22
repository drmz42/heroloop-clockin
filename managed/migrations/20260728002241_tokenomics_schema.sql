/*
# Tokenomics: 1B $HERO supply, 15% daily pool distributed by power

## Overview
Implements a real-time token distribution system:
- Total supply: 1,000,000,000 $HERO tokens (fixed)
- A project-controlled pool receives tokens (from purchases, owner deposits)
- 15% of the current pool is distributed daily among all online+offline players
- Distribution is proportional to each player's team power
- An edge function runs every 60 seconds, calculating per-second shares
- Players accumulate tokens in real-time; they can claim whenever they want

## New Tables

### players
- Stores per-player tokenomics data, synced from the game client
- `user_id` (uuid, PK, references auth.users) — the player's account
- `username` (text) — display name
- `power` (bigint) — current team power (sum of hero + gear stats)
- `account_level` (int) — player level
- `online` (boolean) — whether the player is currently active (heartbeat within 5 min)
- `last_heartbeat` (timestamptz) — last time the player's client pinged the server
- `pending_tokens` (numeric) — accumulated unclaimed token rewards (fractional, claimed in whole tokens)
- `total_claimed` (numeric) — lifetime claimed tokens
- `updated_at` (timestamptz) — last data sync

### token_pool
- Single-row table tracking the project's distribution pool
- `id` (int, PK, always 1) — singleton
- `pool_amount` (numeric) — current tokens available for distribution
- `total_distributed` (numeric) — lifetime tokens distributed to players
- `distribution_rate` (numeric) — fraction of pool distributed per day (default 0.15 = 15%)
- `updated_at` (timestamptz)

### distribution_log
- Audit trail of each distribution tick
- `id` (uuid, PK)
- `tick_at` (timestamptz) — when this distribution ran
- `total_power` (bigint) — sum of all eligible players' power at this tick
- `player_count` (int) — number of eligible players
- `amount_distributed` (numeric) — total tokens distributed in this tick
- `interval_seconds` (int) — the tick interval (should be 60)

## Security (RLS)
- players: owner-scoped CRUD (TO authenticated, auth.uid() = user_id)
- token_pool: public read (TO anon, authenticated) so the frontend can display pool stats; writes are server-only via service role in edge function
- distribution_log: public read (TO anon, authenticated) for transparency; writes are server-only
*/