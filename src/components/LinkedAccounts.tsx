import { useCallback, useEffect, useRef, useState } from 'react';
import { AtSign, CheckCircle2, Link2, Send } from 'lucide-react';
import { playerSync } from '@/game/backend';
import { PROVIDER_LABEL, SOCIAL_LINKS_CHANGED, type PartnerQuestList, type SocialLinks, type SocialProvider } from '@/components/PartnerQuests';

const RESULT_TEXT: Record<string, string> = {
  linked: 'Account linked.',
  social_account_taken: 'This account is already linked to another player.',
  social_link_cooldown: 'You can switch to another account once per 24 hours.',
  social_link_expired: 'The link request expired. Please try again.',
  social_link_cancelled: 'Linking was cancelled.',
  social_provider_unavailable: 'Linking is not available yet.',
  rate_limited: 'Too many attempts. Please wait a moment.',
};
const FALLBACK_TEXT = 'Linking is temporarily unavailable.';

// Partner Quests need the player's own X/Telegram account, verified by the
// provider: X via its sign-in page, Telegram via a one-time code sent to our
// bot. One account can be linked to one player only.
export function LinkedAccounts({ onLinksChange }: { onLinksChange?: (links: SocialLinks) => void } = {}) {
  const [links, setLinks] = useState<SocialLinks | null>(null);
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [message, setMessage] = useState<Partial<Record<SocialProvider, { ok: boolean; text: string }>>>({});
  const waiting = useRef<number | null>(null);

  const load = useCallback(async () => {
    const result = await playerSync<PartnerQuestList>('partner_quest_list', {});
    if (result?.links) {
      setLinks(result.links);
      onLinksChange?.(result.links);
    }
    return result?.links ?? null;
  }, [onLinksChange]);

  useEffect(() => {
    void load();
    // Returning from the X sign-in page: show its result once, then drop it from the URL.
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('social_link');
    const result = params.get('result');
    if ((provider === 'x' || provider === 'telegram') && result) {
      setMessage({ [provider]: { ok: result === 'linked', text: RESULT_TEXT[result] ?? FALLBACK_TEXT } });
      params.delete('social_link');
      params.delete('result');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
      if (result === 'linked') window.dispatchEvent(new Event(SOCIAL_LINKS_CHANGED));
    }
    return () => { if (waiting.current) window.clearInterval(waiting.current); };
  }, [load]);

  const link = async (provider: SocialProvider) => {
    setBusy(provider);
    setMessage((current) => ({ ...current, [provider]: undefined }));
    let code = '';
    const result = await playerSync<{ url: string }>('social_link_start', { provider }, (error) => { code = error; });
    if (!result?.url) {
      setMessage((current) => ({ ...current, [provider]: { ok: false, text: RESULT_TEXT[code] ?? FALLBACK_TEXT } }));
      setBusy(null);
      return;
    }
    if (provider === 'x') {
      window.location.assign(result.url);
      return;
    }
    // Telegram: the bot confirms in the chat; poll until the link appears.
    window.open(result.url, '_blank', 'noopener');
    setMessage((current) => ({ ...current, telegram: { ok: true, text: 'Press Start in the Telegram bot, then come back here.' } }));
    const before = links?.telegram?.handle ?? null;
    let attempts = 0;
    if (waiting.current) window.clearInterval(waiting.current);
    waiting.current = window.setInterval(() => {
      attempts += 1;
      void load().then((next) => {
        const linked = next?.telegram?.handle ?? null;
        if (linked && linked !== before) {
          if (waiting.current) window.clearInterval(waiting.current);
          waiting.current = null;
          setMessage((current) => ({ ...current, telegram: { ok: true, text: RESULT_TEXT.linked } }));
          window.dispatchEvent(new Event(SOCIAL_LINKS_CHANGED));
        } else if (attempts >= 40 && waiting.current) {
          window.clearInterval(waiting.current);
          waiting.current = null;
        }
      });
    }, 3_000);
    setBusy(null);
  };

  if (!links) return null;
  return (
    <section className="stat-tile p-4" aria-label="Linked accounts">
      <h3 className="flex items-center gap-2 text-sm font-black text-[#f1d188]"><Link2 size={16} /> Linked accounts</h3>
      <p className="mt-1 text-[11px] leading-5 text-[#8f887b]">Required for Special Quests. Proof links must come from the account you link here.</p>
      <div className="mt-2 space-y-2">
        {(['x', 'telegram'] as const).map((provider) => {
          const linked = links[provider];
          const note = message[provider];
          const shownHandle = linked && !(provider === 'telegram' && /^tg[0-9]+$/.test(linked.handle)) ? `@${linked.handle}` : 'Linked';
          return (
            <div key={provider}>
              <div className="flex items-center gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-[#a79a82]">
                  {provider === 'x' ? <AtSign size={12} /> : <Send size={12} />} {PROVIDER_LABEL[provider]}
                  {linked && <span className="flex min-w-0 items-center gap-1 truncate normal-case tracking-normal text-emerald-300"><CheckCircle2 size={11} /> {shownHandle}</span>}
                </span>
                <button type="button" onClick={() => void link(provider)} disabled={busy !== null}
                  className={`game-control shrink-0 px-3 text-xs font-bold disabled:opacity-45 ${linked ? '' : 'game-primary'}`}>
                  {busy === provider ? 'Opening…' : linked ? 'Change' : `Link ${provider === 'x' ? 'X' : 'Telegram'}`}
                </button>
              </div>
              {note && <p role={note.ok ? 'status' : 'alert'} className={`mt-1 text-[11px] ${note.ok ? 'text-emerald-300' : 'text-red-300'}`}>{note.text}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
