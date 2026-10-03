import { useSkrRate } from '@/game/skrPurchase';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Crown, ShoppingBag, Wallet, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { playerSync } from '@/game/backend';
import { skrBoostTasks, type SkrBoostStatus } from '@/game/skrBoost';
import { LinkedAccounts } from './LinkedAccounts';

export function SkrBoostMaxModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<SkrBoostStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await playerSync<SkrBoostStatus>('skr_boost_status');
    setStatus(result);
    setFailed(!result);
    setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!buttons.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const rate = useSkrRate();
  const tasks = skrBoostTasks(status, rate);
  return createPortal(
    <div className="hl-portal fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-3 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className="px-panel-raised flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl" role="dialog" aria-modal="true" aria-labelledby="skr-boost-title">
        <header className="flex items-start justify-between gap-3 border-b border-[#5d4a2f] px-4 py-3">
          <div><div className="section-kicker">SKR rewards</div><h2 id="skr-boost-title" className="mt-1 flex items-center gap-2 text-2xl font-black text-[#f1d188]"><Crown size={22} /> Boost Max</h2></div>
          <button type="button" onClick={onClose} className="game-control grid !min-h-[44px] !min-w-[44px] place-items-center" aria-label="Close Boost Max"><X size={18} /></button>
        </header>
        <div className="game-scrollbar min-h-0 space-y-3 overflow-y-auto p-4">
          <section className="stat-tile p-4" aria-label="SKR Boost tasks">
            <p className="text-sm font-bold text-[#e3dccf]">Complete your SKR tasks</p>
            <p className="mt-1 text-xs leading-5 text-[#aaa397]">Your progress is confirmed by the server. Targets use the current server SKR rate.</p>
            <ul className="mt-4 space-y-4">
              {tasks.map(task => <li key={task.key} className="flex items-start gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#51442f] text-[#dcb55f]">{task.key === 'spend' ? <ShoppingBag size={17} /> : <Wallet size={17} />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-[#e3dccf]">{task.label}</span>{task.done ? <CheckCircle2 size={18} className="shrink-0 text-emerald-400" aria-label="Completed" /> : <Circle size={18} className="shrink-0 text-[#625b50]" aria-label="Not completed" />}</div>
                  <p className="mt-1 text-[11px] leading-5 text-[#aaa397]">{task.detail}</p>
                  <p className="mt-1 break-words text-xs font-bold tabular-nums text-[#dcb55f]">{loading ? 'Checking…' : task.progress}</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/50" role="progressbar" aria-label={task.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(task.percent)}><div className={`h-full ${task.done ? 'bg-emerald-400' : 'bg-[#d9a441]'}`} style={{ width: `${task.percent}%` }} /></div>
                </div>
              </li>)}
            </ul>
            <p role={failed ? 'alert' : 'status'} className="mt-4 text-xs leading-5 text-[#aaa397]">{failed ? 'Could not check your progress. Please try again.' : 'SKR payments and reward activation are not available yet. Your game balance is not counted as SKR.'}</p>
            <button type="button" onClick={() => void refresh()} disabled={loading} className="game-control mt-3 !min-h-[44px] w-full px-4 text-xs font-bold disabled:opacity-45">{loading ? 'Checking…' : 'Refresh progress'}</button>
          </section>
          <div className="[&_button]:!min-h-[44px]"><LinkedAccounts /></div>
        </div>
      </div>
    </div>, document.body,
  );
}
