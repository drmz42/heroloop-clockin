import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Copy, ShieldCheck, UserRound, X } from 'lucide-react';
import { formatNum } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { solanaAuthEnabled, unlinkSolanaIdentity } from '@/game/solanaWalletSession';

export function GameWalletModal({
  guestId,
  balance,
  onClose,
}: {
  guestId: string;
  balance: number;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [identityAction, setIdentityAction] = useState<'unlink' | 'provider_revoke' | null>(null);
  const [identityError, setIdentityError] = useState('');

  const copyGuestId = async () => {
    await navigator.clipboard?.writeText(guestId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
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
      setIdentityError(code === 'last_identity_required'
        ? 'This wallet is your last active identity. Add another verified sign-in method before unlinking it.'
        : code === 'wallet_rate_limited'
        ? 'Too many identity changes. Wait one minute and try again.'
        : 'The identity change failed safely. Your account and wallet link are unchanged.');
    } finally {
      setIdentityAction(null);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/80 p-4 backdrop-blur-md">
      <section className="px-panel-raised relative w-full max-w-lg overflow-hidden rounded-2xl">
        <div className="border-b border-white/10 bg-gradient-to-r from-violet-500/10 to-amber-400/5 p-6">
          <button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-2 text-slate-500 hover:bg-white/5 hover:text-white" aria-label="Close wallet">
            <X size={19} />
          </button>
          <div className="grid h-12 w-12 place-items-center rounded-xl border border-violet-400/30 bg-violet-400/10 text-violet-300">
            <UserRound size={24} />
          </div>
          <h2 className="mt-5 font-pixel text-lg text-white">GAME ACCOUNT</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
            {solanaAuthEnabled ? 'Your verified Solana sign-in and server-saved game balance.' : 'Your temporary beta account and server-saved game balance.'}
          </p>
        </div>

        <div className="space-y-5 p-6">
          <div className="rounded-xl border border-violet-400/20 bg-violet-400/[.06] p-5">
            <div className="text-xs font-semibold uppercase tracking-[.16em] text-slate-500">Available balance</div>
            <div className="mt-2 flex items-center gap-2 text-3xl font-extrabold text-violet-200">
              <HeroTokenIcon size={24} /> {formatNum(balance)}
              <span className="text-sm font-semibold text-slate-500">$HERO</span>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-[.16em] text-slate-500">{solanaAuthEnabled ? 'HeroLoop account ID' : 'Guest ID'}</div>
            <button onClick={copyGuestId} aria-label={`Copy ${solanaAuthEnabled ? 'HeroLoop account ID' : 'Guest ID'}`} className="mt-2 flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/25 p-4 text-left hover:border-violet-400/35">
              <code className="min-w-0 flex-1 truncate text-sm text-slate-300">{guestId}</code>
              {copied ? <Check size={18} className="text-emerald-400" /> : <Copy size={18} className="text-slate-500" />}
            </button>
          </div>

          <div className="flex gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[.04] p-4 text-xs leading-5 text-slate-400">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-amber-300" />
            {solanaAuthEnabled ? 'This internal account ID is not your public wallet address. HeroLoop login signatures never move funds or cost gas.' : 'Guest ID is not a Solana address and cannot receive funds. The displayed `$HERO` balance is the current in-game testing balance.'}
          </div>

          {solanaAuthEnabled && (
            <div className="space-y-3 border-t border-white/10 pt-5">
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
        </div>
      </section>
    </div>,
    document.body
  );
}
