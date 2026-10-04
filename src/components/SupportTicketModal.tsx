import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, MessageCircle, X } from 'lucide-react';
import { GameSelect } from '@/components/GameSelect';
import { playerSync } from '@/game/backend';

const TOPICS = [
  { value: 'login_save', label: 'Login or saved progress' },
  { value: 'combat', label: 'Combat or battles' },
  { value: 'heroes', label: 'Heroes or formation' },
  { value: 'items', label: 'Items or inventory' },
  { value: 'rewards', label: 'Rewards or currency' },
  { value: 'quests', label: 'Quests or dungeons' },
  { value: 'interface', label: 'Interface or performance' },
  { value: 'other', label: 'Other game problem' },
] as const;
const PRIORITIES = [
  'Low', 'Normal', 'Important', 'Urgent', 'Critical',
];
const STATUS: Record<string, string> = {
  new: 'New', in_progress: 'In progress', waiting_player: 'Waiting for you', resolved: 'Resolved', closed: 'Closed',
};
const ERRORS: Record<string, string> = {
  support_daily_limit: 'You can create up to three tickets in 24 hours.',
  rate_limited: 'Please wait a little before trying again.',
  ticket_text_carries_identifier: 'Please remove email addresses, wallet keys and long IDs from the description.',
  invalid_ticket_text: 'Please describe the problem in 10 to 2000 characters.',
  feature_paused: 'Support is temporarily unavailable. Please try again later.',
};
type Ticket = {
  id: number; created_at: string; topic: string; priority: number; status: string; body: string;
  replies: { body: string; created_at: string }[];
};

export function SupportTicketModal({ onClose }: { onClose: () => void }) {
  const [topic, setTopic] = useState<(typeof TOPICS)[number]['value']>('login_save');
  const [priority, setPriority] = useState(2);
  const [confirmCritical, setConfirmCritical] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [body, setBody] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const load = async () => {
    setLoading(true);
    let code = '';
    const result = await playerSync<{ tickets: Ticket[] }>('support_ticket_list', {}, (message) => { code = message; });
    if (result) setTickets(result.tickets);
    else setError(ERRORS[code] ?? 'Your tickets could not be loaded. Please try again later.');
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (confirmCritical) confirmButton.current?.focus(); }, [confirmCritical]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (confirmed = false) => {
    if (busy || body.trim().length < 10) return;
    if (priority === 5 && !confirmed) { setConfirmCritical(true); return; }
    setConfirmCritical(false);
    setBusy(true);
    setError('');
    let code = '';
    const result = await playerSync<{ id: number }>('support_ticket_submit', {
      topic, priority, body: body.trim(), idempotency_key: key,
    }, (message) => { code = message; });
    if (result) {
      setSent(true);
      setBody('');
      setPriority(2);
      setKey(crypto.randomUUID());
      await load();
    } else setError(ERRORS[code] ?? 'The ticket could not be sent. Please try again.');
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[4px]" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="support-title" className="px-panel-raised flex max-h-[calc(100dvh-24px)] w-full max-w-lg flex-col rounded-2xl border border-[#9a6a22] shadow-[0_24px_90px_rgba(0,0,0,.8)]">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#51422e] p-4">
          <div><div className="section-kicker flex items-center gap-2"><MessageCircle size={14} /> Support</div><h2 id="support-title" className="mt-1 font-vt text-xl font-black text-[#f0dfbb]">Game support</h2></div>
          <button type="button" onClick={onClose} disabled={busy} className="game-control grid h-10 w-10 shrink-0 place-items-center" aria-label="Close support"><X size={17} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          <p className="text-xs leading-5 text-[#c9c2b6]">Tell us what happened in the game. Choose how urgent it feels to you. Replies approved by our team appear here; no email or wallet address is needed.</p>
          {sent && <p role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 text-xs text-emerald-200"><CheckCircle2 size={16} /> Ticket created. You can check its status below.</p>}
          <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="text-xs font-bold text-[#f0dfbb]" htmlFor="support-topic">Game problem</label>
            <GameSelect id="support-topic" ariaLabel="Game problem" value={topic} onChange={setTopic} options={TOPICS.map((item) => ({ value: item.value, label: item.label }))} className="game-control min-h-11 w-full bg-[#15130f] px-3 text-sm text-[#f4e6c7]" />
            <label className="text-xs font-bold text-[#f0dfbb]" htmlFor="support-priority">Priority</label>
            <GameSelect id="support-priority" ariaLabel="Priority" value={priority} onChange={(selected) => { setPriority(selected); setConfirmCritical(selected === 5); }} options={PRIORITIES.map((label, index) => ({ value: index + 1, label }))} className="game-control min-h-11 w-full bg-[#15130f] px-3 text-sm text-[#f4e6c7]" />
            <label className="text-xs font-bold text-[#f0dfbb]" htmlFor="support-details">What happened?</label>
            <textarea id="support-details" value={body} onChange={(event) => { setBody(event.target.value); setSent(false); setError(''); }} minLength={10} maxLength={2000} rows={4} required className="game-control w-full resize-y bg-[#15130f] px-3 py-2 text-sm text-[#f4e6c7]" placeholder="What were you doing, what did you expect, and what happened instead?" />
            <div className="text-right text-[10px] text-[#a79a82]">{body.length}/2000</div>
            {error && <p role="alert" ref={(node) => node?.scrollIntoView({ block: 'nearest' })} className="rounded border border-red-700/50 bg-red-950/35 p-3 text-xs text-red-200">{error}</p>}
            {confirmCritical && <div role="alertdialog" aria-label="Confirm critical priority" className="rounded-lg border border-red-600/60 bg-red-950/40 p-3 text-xs text-red-100">
              <p className="font-bold">Are you sure this is critical?</p>
              <p className="mt-2">Critical priority is only for serious problems that need immediate attention. Please do not mark ordinary problems as critical or send false reports. These tickets are reviewed first.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="game-control min-h-11 px-3" onClick={() => { setPriority(2); setConfirmCritical(false); }}>Choose another priority</button>
                <button ref={confirmButton} type="button" disabled={busy || body.trim().length < 10} className="game-control game-primary min-h-11 px-3 disabled:opacity-45" onClick={() => void submit(true)}>Yes, create critical ticket</button>
              </div>
            </div>}
            {!confirmCritical && <button type="submit" disabled={busy || body.trim().length < 10} className="game-control game-primary min-h-11 w-full px-4 py-2 text-xs font-black disabled:opacity-45">{busy ? 'Sending…' : 'Create ticket'}</button>}
          </form>
          <div className="mt-6 border-t border-[#51422e] pt-4">
            <h3 className="font-vt text-lg font-bold text-[#f0dfbb]">Your tickets</h3>
            {loading ? <p className="mt-2 text-xs text-[#c9c2b6]">Loading…</p> : tickets.length === 0 ? <p className="mt-2 text-xs text-[#c9c2b6]">No tickets yet.</p> : (
              <div className="mt-2 grid gap-2">
                {tickets.map((ticket) => <article key={ticket.id} className="rounded-lg border border-[#51422e] bg-black/20 p-3 text-xs text-[#c9c2b6]">
                  <div className="flex flex-wrap items-center justify-between gap-1"><strong className="text-[#f0dfbb]">#{ticket.id} · {TOPICS.find((item) => item.value === ticket.topic)?.label ?? 'Game problem'}</strong><span>{STATUS[ticket.status] ?? ticket.status}</span></div>
                  <p className="mt-1 text-[10px]">{PRIORITIES[ticket.priority - 1] ?? 'Priority'} · {new Date(ticket.created_at).toLocaleString()}</p>
                  <p className="mt-2 whitespace-pre-wrap break-words">{ticket.body}</p>
                  {ticket.replies.map((reply, index) => <div key={`${ticket.id}-${index}`} className="mt-2 rounded border border-emerald-500/30 bg-emerald-950/20 p-2"><strong className="text-emerald-200">Support reply</strong><p className="mt-1 whitespace-pre-wrap break-words">{reply.body}</p></div>)}
                </article>)}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
