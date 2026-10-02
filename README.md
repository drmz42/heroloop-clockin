# HeroLoop — Seeker edition (Solana Mobile CLOCK IN)

HeroLoop is an idle team RPG: you assemble a hero squad, it fights through locations on its own (also while you are away), and you return to collect rewards, open chests, equip and enchant items and push into dungeons. This repository is the **Seeker edition** built for Solana Mobile: an Android app for the Seeker phone with Solana wallet sign-in and an isolated, SKR-only economy.

> **About this repository.** HeroLoop is developed in our private main repository since July 2026. This is a filtered export of the Seeker edition: it keeps the original commits, dates and messages for the game client, backend and Android app, and leaves out internal operations, infrastructure and planning files. Work during CLOCK IN (from 8 September 2026) focused on the Android app, Solana wallet sign-in through the Mobile Wallet Adapter and the SKR economy.

## What is in the box

| Path | What it is |
| --- | --- |
| `src/` | Game client: React + TypeScript + Vite. Combat view, heroes, inventory, chests, dungeons, landing page. |
| `managed/functions/player-sync/` | Shared, deterministic game rules (combat steps, balance, healing) used by both client and server. |
| `selfhosted/` | Backend: Deno API (`selfhosted/api`), worker, PostgreSQL schema and migrations, Supabase GoTrue for Auth, Docker Compose files. |
| `selfhosted/api/seeker_edition.ts` | Seeker-edition gate: the server refuses actions that do not belong to the SKR-only edition. |
| `selfhosted/seeker/` | SKR double-entry ledger in its own database (`seeker_skr`), separate from game data. |
| `selfhosted/api/skr_quote.ts` | SKR pricing and payment verification (integer minimal units, no floats). |
| `android/seeker-app/` | Native Android app: a full-screen WebView shell whose Mobile Wallet Adapter connects to any installed Solana wallet (Seed Vault, Phantom, Solflare, Backpack). |
| `config/` | Versioned game data: balance tables, enchanting, tutorial quests, feature flags. |

### Solana integration

- **Sign in with Solana** through the Mobile Wallet Adapter (`@solana-mobile/wallet-standard-mobile`). The server issues a one-time challenge and verifies the wallet signature (`SIWS_*` settings) before it creates a session.
- **SKR token** (`SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, 6 decimals, mainnet) is the only currency of this edition. Amounts are integers in minimal units; the ledger is idempotent and balanced per event.
- **The server is the authority.** Rewards, balances, inventory and combat results are computed on the server; the client never sends values the server trusts.

## Requirements

- Node.js 22 and npm 10
- For the backend: Docker with Compose v2
- For the APK: JDK 17 and an Android SDK with `platforms;android-36` and `build-tools;36.0.0` (`ANDROID_HOME` set)

## 1. Build the game client

```bash
npm ci
npm run build:web        # production bundle in dist/, configured by .env.staging2
```

`.env.staging2` only holds public client settings; it points the client at the hosted Seeker backend `https://staging2.heroloop.xyz`.

## 2. Build the Android APK

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
npm run apk:debug
# -> android/seeker-app/app/build/outputs/apk/debug/app-debug.apk (SHA-256 printed)
```

Install it with `adb install -r android/seeker-app/app/build/outputs/apk/debug/app-debug.apk`. The app opens the hosted Seeker game; signing in asks your wallet app to approve the Solana sign-in message. The release APK we submit is signed with a separate key that is not part of this repository.

## 3. Run the backend locally

```bash
npm run backend:local -- up       # Postgres, Auth, wallet Auth, API, worker and the SKR ledger
npm run backend:local -- status
npm run backend:local -- down     # stops everything and deletes the local database volume
```

The first `up` generates fresh random secrets into `selfhosted/clockin.env.local` (git-ignored) and applies the database baseline and the SKR ledger schema. When it prints `Backend ready`, the API answers on `http://127.0.0.1:28081/api/v1/health` and Auth on `http://127.0.0.1:29999/health`. Ports can be changed with `HL_LOCAL_API_PORT`, `HL_LOCAL_AUTH_PORT` and `HL_LOCAL_DB_PORT`.

## Tests

```bash
npx tsx --test test/solanaWallet*.test.ts test/authTransient.test.ts     # wallet sign-in and session (30 tests)
docker run --rm -v "$PWD/selfhosted:/app:ro" -w /app denoland/deno:2.9.4 \
  test --config=/app/deno.json --cached-only seeker/ api/skr_quote_test.ts api/seeker_edition_test.ts   # SKR ledger, quotes, edition gate
```

## Security

No credentials, keys or production configuration are stored in this repository. Every secret is generated per environment at install time.
