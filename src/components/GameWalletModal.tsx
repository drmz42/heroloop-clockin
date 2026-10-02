import { isolatedHackathon } from '@/game/editionStorage';
import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, Copy, History, Lock, ShieldCheck, UserRound, Wallet, X,
} from 'lucide-react';
import { formatNum } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { shortWalletAddress } from '@/components/walletAddress';
import { solanaAuthEnabled, unlinkSolanaIdentity } from '@/game/solanaWalletSession';
import { SeekerDepositPanel, SeekerHistoryPanel } from '@/components/SeekerWalletPanels';

import { SeekerWithdrawalPanel,SeekerFounderPanel } from '@/components/SeekerWithdrawalPanels';

type WalletTab = 'deposit' | 'withdraw' | 'history' | 'account';

const TABS: { id: WalletTab; label: string; icon: typeof Wallet }[] = [
  { id: 'deposit', label: 'Deposit', icon: ArrowDownToLine },
  { id: 'withdraw', label: 'Withdraw', icon: ArrowUpFromLine },
  { id: 'history', label: 'History', icon: History },
  { id: 'account', label: 'Account', icon: UserRound },
];

export function GameWalletModal({
  guestId,
  walletAddress,
  balance,
  pending,
  claimed,
  earned,
  onClose,
  onPurchase,
}: {
  guestId: string;
  walletAddress: string | null;
  balance: number;
  pending: number;
  claimed: number;
  earned: number;
  onClose: () => void;
  onPurchase?: (result:Record<string,unknown>)=>void;
}) {
  const [tab, setTab] = useState<WalletTab>(walletAddress ? 'deposit' : 'account');
  const [copied, setCopied] = useState<'wallet' | 'id' | null>(null);
  const [identityAction, setIdentityAction] = useState<'unlink' | 'provider_revoke' | null>(null);
  const [identityError, setIdentityError] = useState('');

  const copy = async (value: string, kind: 'wallet' | 'id') => {
    await navigator.clipboard?.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const changeIdentity = async (action: 'unlink' | 'provider_revoke') => {
    const confirmed = window.confirm(action === 'unlink'
      ? 'Unlink this Solana wallet? HeroLoop will refuse if it is your last active sign-in method.'
      : 'Lock this Solana identity and revoke every wallet session? If it is your only identity, the account stays recovery-locked until another verified provider can restore access.');
    if (!confirmed) return;
    setIdentityAction(action);
    setIdentityError('');
    try {
      await unlinkSolanaIdentity(action);
      window.location.replace('/');
    } catch (reason) {
      const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : '';
      setIdentityError(code === 'wallet_session_unavailable'
        ? 'Your wallet proof expired. Log out, reconnect Phantom, then try again.'
        : code === 'last_identity_required'
        ? 'This wallet is your last active identity. Add another verified sign-in method before unlinking it.'
        : code === 'wallet_rate_limited'
        ? 'Too many identity changes. Wait one minute and try again.'
        : 'The identity change failed safely. Your account and wallet link are unchanged.');
    } finally {
      setIdentityAction(null);
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(TABS.findIndex((entry) => entry.id === tab) + step + TABS.length) % TABS.length];
    setTab(next.id);
    document.getElementById(`wallet-tab-${next.id}`)?.focus();
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-3 backdrop-blur-[3px] anim-fade" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="px-panel-raised relative flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl" role="dialog" aria-modal="true" aria-label="Wallet">
        <header className="flex items-start justify-between gap-3 border-b border-[#5d4a2f] px-4 py-3">
          <div className="min-w-0">
            <div className="section-kicker">HeroLoop</div>
            <h2 className="mt-1 flex items-center gap-2 text-2xl font-black text-[#f1d188]"><Wallet size={22} /> Wallet</h2>
            {walletAddress ? (
              <button type="button" onClick={() => void copy(walletAddress, 'wallet')} className="mt-1.5 flex max-w-full items-center gap-1.5 rounded-full border border-[#54462f] bg-black/30 px-2.5 py-1 text-xs font-semibold text-[#cfc7b6] hover:border-[#9a6a22]" aria-label="Copy wallet address" title={walletAddress}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                <code className="truncate">{shortWalletAddress(walletAddress)}</code>
                {copied === 'wallet' ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} className="text-[#8f887b]" />}
              </button>
            ) : (
              <p className="mt-1 text-xs text-[#aaa397]">No Solana wallet linked to this account.</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!isolatedHackathon && <div className="flex h-9 items-center gap-1.5 rounded-full border border-lime-500/40 bg-[#0d1009] px-3" title="In-game $HERO balance">
              <HeroTokenIcon size={14} />
              <span className="text-sm font-black tabular-nums text-lime-300">{formatNum(balance)}</span>
            </div>}
            <button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center" aria-label="Close wallet"><X size={16} /></button>
          </div>
        </header>

        <div role="tablist" aria-label="Wallet sections" onKeyDown={onTabKey} className="grid grid-cols-4 border-b border-[#5d4a2f] bg-black/20">
          {TABS.map((entry) => {
            const Icon = entry.icon;
            const active = tab === entry.id;
            return (
              <button
                key={entry.id}
                id={`wallet-tab-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`wallet-panel-${entry.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(entry.id)}
                className={`flex min-h-11 flex-col items-center justify-center gap-0.5 border-b-2 px-1 py-1.5 text-[11px] font-bold sm:flex-row sm:gap-1.5 sm:text-xs ${active ? 'border-[#e0a83c] text-[#f6d283]' : 'border-transparent text-[#8f887b] hover:text-[#d9d1c0]'}`}
              >
                <Icon size={15} aria-hidden="true" /> {entry.label}
              </button>
            );
          })}
        </div>

        <div id={`wallet-panel-${tab}`} role="tabpanel" aria-labelledby={`wallet-tab-${tab}`} className="game-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {tab === 'deposit' && isolatedHackathon && <SeekerDepositPanel />}
          {tab === 'history' && isolatedHackathon && <SeekerHistoryPanel onPurchase={onPurchase} />}

          {tab === 'deposit' && !isolatedHackathon && (
            <>
              <NotLive title="On-chain deposits are not live yet">
                {isolatedHackathon ? 'SKR deposits are not connected yet. Balance verification and payment processing must be available before deposits open.' : 'In-game $HERO is an internal server balance today. Deposits open only after the on-chain token launches and Founder approves the launch.'}
              </NotLive>
              <AmountField label="Amount to deposit" balanceLabel={`In-game balance: ${(isolatedHackathon ? '—' : formatNum(balance))} $HERO`} />
              <button type="button" disabled className="game-control flex w-full items-center justify-center gap-2 px-4 py-3 font-black opacity-45"><Lock size={16} /> Deposit unavailable</button>
              <SafetyNote>Never send tokens to your HeroLoop account ID. It is not a Solana address and cannot receive funds.</SafetyNote>
            </>
          )}

          {tab === 'withdraw' && isolatedHackathon && <SeekerWithdrawalPanel />}
          {tab === 'withdraw' && !isolatedHackathon && (
            <>
              <NotLive title="Withdrawals are not live yet">
                Limits, fees and cooldowns will be published here once they are approved. Nothing can leave the game before then.
              </NotLive>
              <AmountField label="Amount to withdraw" balanceLabel={`Available: ${(isolatedHackathon ? '—' : formatNum(balance))} $HERO`} />
              <div className="stat-tile flex items-center justify-between gap-3 p-3 text-xs">
                <span className="text-[#918b80]">Destination wallet</span>
                <code className="text-[#e3dccf]">{walletAddress ? shortWalletAddress(walletAddress) : 'Link a wallet first'}</code>
              </div>
              <button type="button" disabled className="game-control flex w-full items-center justify-center gap-2 px-4 py-3 font-black opacity-45"><Lock size={16} /> Withdrawals unavailable</button>
            </>
          )}

          {tab === 'history' && !isolatedHackathon && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <SummaryTile label="In-game balance" value={(isolatedHackathon ? '—' : formatNum(balance))} tone="lime" />
                <SummaryTile label="Ready to claim" value={(isolatedHackathon ? '—' : formatNum(pending))} tone="gold" />
                <SummaryTile label="Total claimed" value={(isolatedHackathon ? '—' : formatNum(claimed))} tone="muted" />
                <SummaryTile label="Total earned" value={(isolatedHackathon ? '—' : formatNum(earned))} tone="muted" />
              </div>
              <div className="stat-tile p-3 text-xs leading-5 text-[#a29b8e]">
                {isolatedHackathon ? 'Verified SKR transaction history is not connected yet. No SKR balance or payment totals are available.' : 'A dated list of individual transactions is not available yet. These totals come from your server-saved account. There are no blockchain transactions to show because on-chain $HERO is not live.'}
              </div>
            </>
          )}

          {tab === 'account' && (
            <>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[.16em] text-[#8f887b]">{solanaAuthEnabled ? 'HeroLoop account ID' : 'Guest ID'}</div>
                <button onClick={() => void copy(guestId, 'id')} aria-label={`Copy ${solanaAuthEnabled ? 'HeroLoop account ID' : 'Guest ID'}`} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/25 p-3 text-left hover:border-[#9a6a22]">
                  <code className="min-w-0 flex-1 truncate text-sm text-slate-300">{guestId}</code>
                  {copied === 'id' ? <Check size={18} className="text-emerald-400" /> : <Copy size={18} className="text-slate-500" />}
                </button>
              </div>

              <div className="flex gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[.04] p-3 text-xs leading-5 text-slate-400">
                <ShieldCheck size={18} className="mt-0.5 shrink-0 text-amber-300" />
                {solanaAuthEnabled ? 'This internal account ID is not your public wallet address. HeroLoop login signatures never move funds or cost gas.' : 'Guest ID is not a Solana address and cannot receive funds. The displayed `$HERO` balance is the current in-game testing balance.'}
              </div>

              {isolatedHackathon && <SeekerFounderPanel />}
              {solanaAuthEnabled && (
                <div className="space-y-3 border-t border-white/10 pt-4">
                  <div className="flex gap-3 text-xs leading-5 text-slate-400">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-300" />
                    <span>Unlink is blocked for your last identity. Emergency lock revokes every Solana session and may leave the account recovery-locked.</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button type="button" disabled={identityAction !== null} onClick={() => void changeIdentity('unlink')} className="game-control min-h-11 border border-white/15 px-3 text-xs font-bold text-slate-300 disabled:opacity-50">{identityAction === 'unlink' ? 'Checking…' : 'Unlink wallet'}</button>
                    <button type="button" disabled={identityAction !== null} onClick={() => void changeIdentity('provider_revoke')} className="game-control min-h-11 border border-rose-400/30 px-3 text-xs font-bold text-rose-300 disabled:opacity-50">{identityAction === 'provider_revoke' ? 'Locking…' : 'Emergency lock'}</button>
                  </div>
                  {identityError && <div role="alert" className="border border-rose-400/30 bg-rose-400/10 p-3 text-xs leading-5 text-rose-200">{identityError}</div>}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}

function NotLive({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-[#8a6a2a]/60 bg-[#2a2010]/50 p-3">
      <Lock size={18} className="mt-0.5 shrink-0 text-[#e0a83c]" />
      <div>
        <div className="text-sm font-black text-[#f1d188]">{title}</div>
        <p className="mt-1 text-xs leading-5 text-[#b9b09d]">{children}</p>
      </div>
    </div>
  );
}

function AmountField({ label, balanceLabel }: { label: string; balanceLabel: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-[.14em] text-[#8f887b]">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <input disabled value="" placeholder="0" aria-label={label} className="min-h-12 min-w-0 flex-1 rounded-xl border border-[#3f3626] bg-black/30 px-4 text-lg font-bold text-[#5f584b] opacity-60" />
        <span className="rounded-lg border border-[#3f3626] px-2.5 py-2 text-[10px] font-black uppercase tracking-wider text-[#5f584b]">Max</span>
        <span className="text-xs font-bold text-[#8f887b]">$HERO</span>
      </div>
      <div className="mt-1.5 text-[11px] font-semibold text-[#8f887b]">{balanceLabel}</div>
    </div>
  );
}

function SafetyNote({ children }: { children: ReactNode }) {
  return <div className="flex gap-2 text-[11px] leading-5 text-[#8f887b]"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-amber-300/80" />{children}</div>;
}

function SummaryTile({ label, value, tone }: { label: string; value: string; tone: 'lime' | 'gold' | 'muted' }) {
  const color = tone === 'lime' ? 'text-lime-300' : tone === 'gold' ? 'text-[#f1c862]' : 'text-[#d9d1c0]';
  return (
    <div className="stat-tile p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[#8f887b]">{label}</div>
      <div className={`mt-1 flex items-center gap-1.5 text-xl font-black tabular-nums ${color}`}><HeroTokenIcon size={16} /> {value}</div>
    </div>
  );
}
