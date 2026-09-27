import { useState } from 'react';
import { CheckCircle2, Flag, X } from 'lucide-react';
import { playerSync } from '@/game/backend';

// A report changes nothing in the game by itself; the Founder reviews it in the
// Control Center. The reporter is never shown to the reported player.
const REASONS = [
  { value: 'cheating', label: 'Cheating or exploiting' },
  { value: 'bot', label: 'Bot or automation' },
  { value: 'offensive_name', label: 'Offensive name' },
  { value: 'other', label: 'Something else' },
] as const;

type ReportReason = typeof REASONS[number]['value'];

const ERROR_TEXT: Record<string, string> = {
  report_daily_limit: 'You have sent the maximum number of reports for today.',
  report_target_not_found: 'This player no longer exists.',
  report_self: 'You cannot report yourself.',
  rate_limited: 'Too many reports. Please wait and try again.',
  feature_paused: 'Reports are paused right now. Please try again later.',
};

export function PlayerReportModal({ target, onClose }: { target: { playerId: string; username: string }; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'' | 'recorded' | 'already_reported'>('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const submit = async () => {
    if (busy || !reason) return;
    setBusy(true);
    setError('');
    let errorCode = '';
    const trimmed = comment.trim();
    const result = await playerSync<{ status: 'recorded' | 'already_reported' }>('player_report', {
      target_player_id: target.playerId, reason, comment: trimmed || null, idempotency_key: idempotencyKey,
    }, (message) => { errorCode = message; });
    if (result) setDone(result.status === 'already_reported' ? 'already_reported' : 'recorded');
    else setError(ERROR_TEXT[errorCode] ?? 'The report could not be sent. Please try again later.');
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[4px]" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="report-title" className="px-panel-raised w-full max-w-md rounded-2xl border border-[#9a6a22] p-5 shadow-[0_24px_90px_rgba(0,0,0,.8)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><div className="section-kicker flex items-center gap-2"><Flag size={14} /> Report player</div><h2 id="report-title" className="mt-1 truncate font-vt text-xl font-black text-[#f0dfbb]">{target.username}</h2></div>
          <button type="button" onClick={onClose} className="game-control grid h-9 w-9 shrink-0 place-items-center" aria-label="Close"><X size={16} /></button>
        </div>
        {done ? (
          <div className="mt-5 rounded-xl border border-emerald-500/45 bg-emerald-950/30 p-4 text-center">
            <CheckCircle2 size={28} className="mx-auto text-emerald-300" />
            <strong className="mt-2 block text-sm text-emerald-200">{done === 'already_reported' ? 'Already reported today' : 'Report sent'}</strong>
            <p className="mt-2 text-xs leading-5 text-[#c9c2b6]">Our team reviews every report. The player is not told who reported them.</p>
            <button type="button" onClick={onClose} className="game-control game-primary mt-4 w-full px-4 py-2 text-xs font-black">Done</button>
          </div>
        ) : (
          <form className="mt-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <fieldset>
              <legend className="text-[10px] font-bold uppercase tracking-[.12em] text-[#a79a82]">Reason</legend>
              <div className="mt-2 grid gap-1.5">
                {REASONS.map((option) => (
                  <label key={option.value} className={`game-control flex min-h-[44px] cursor-pointer items-center gap-2 px-3 text-xs ${reason === option.value ? 'border-[#d0a34f] text-[#f4e6c7]' : 'text-[#c9c2b6]'}`}>
                    <input type="radio" name="report-reason" value={option.value} checked={reason === option.value} onChange={() => setReason(option.value)} className="accent-[#d0a34f]" />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="mt-4 block text-[10px] font-bold uppercase tracking-[.12em] text-[#a79a82]" htmlFor="report-comment">Details (optional)</label>
            <textarea id="report-comment" value={comment} onChange={(event) => setComment(event.target.value)} maxLength={300} rows={3} className="game-control mt-2 w-full resize-none bg-transparent px-3 py-2 text-xs text-[#f4e6c7] outline-none placeholder:text-[#625b50]" placeholder="What happened?" />
            <div className="mt-1 text-right text-[9px] text-[#7f796f]">{comment.length}/300</div>
            {error && <p role="alert" className="mt-2 rounded border border-red-700/50 bg-red-950/35 px-3 py-2 text-xs text-red-200">{error}</p>}
            <button type="submit" disabled={busy || !reason} className="game-control game-primary mt-3 w-full px-4 py-2.5 text-xs font-black disabled:opacity-45">{busy ? 'Sending…' : 'Send report'}</button>
          </form>
        )}
      </section>
    </div>
  );
}
