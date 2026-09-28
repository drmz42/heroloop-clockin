import { useEffect, useState } from 'react';
import { AtSign, CheckCircle2, Link2, Send } from 'lucide-react';
import { playerSync } from '@/game/backend';
import { PROVIDER_LABEL, SOCIAL_LINKS_CHANGED, type PartnerQuestList, type SocialLinks, type SocialProvider } from '@/components/PartnerQuests';

const ERROR_TEXT: Record<string, string> = {
  invalid_social_handle: 'Enter a valid username.',
  social_handle_taken: 'This account is already linked to another player.',
  social_link_cooldown: 'You can change a linked account once per 24 hours.',
  rate_limited: 'Too many attempts. Please wait a moment.',
};

// Partner Quests need the player's own X/Telegram account: proofs must come
// from it, and one account can be linked to one player only.
export function LinkedAccounts() {
  const [links, setLinks] = useState<SocialLinks | null>(null);
  const [drafts, setDrafts] = useState<Record<SocialProvider, string>>({ x: '', telegram: '' });
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<Partial<Record<SocialProvider, string>>>({});

  useEffect(() => {
    void playerSync<PartnerQuestList>('partner_quest_list', {}).then((result) => {
      if (!result?.links) return;
      setLinks(result.links);
      setDrafts({ x: result.links.x?.handle ?? '', telegram: result.links.telegram?.handle ?? '' });
    });
  }, []);

  const save = async (provider: SocialProvider) => {
    setBusy(provider);
    setError((current) => ({ ...current, [provider]: '' }));
    let code = '';
    const result = await playerSync<SocialLinks>('social_link_set', { provider, handle: drafts[provider] }, (message) => { code = message; });
    if (result) {
      setLinks(result);
      window.dispatchEvent(new Event(SOCIAL_LINKS_CHANGED));
    } else {
      setError((current) => ({ ...current, [provider]: ERROR_TEXT[code] ?? 'Linking is temporarily unavailable.' }));
    }
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
          const changed = drafts[provider].trim().replace(/^@/, '').toLowerCase() !== (linked?.handle ?? '').toLowerCase();
          return (
            <form key={provider} onSubmit={(event) => { event.preventDefault(); void save(provider); }}>
              <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.12em] text-[#a79a82]" htmlFor={`link-${provider}`}>
                {provider === 'x' ? <AtSign size={12} /> : <Send size={12} />} {PROVIDER_LABEL[provider]}
                {linked && <span className="flex items-center gap-1 normal-case tracking-normal text-emerald-300"><CheckCircle2 size={11} /> @{linked.handle}</span>}
              </label>
              <div className="mt-1 flex gap-2">
                <input id={`link-${provider}`} value={drafts[provider]} onChange={(event) => setDrafts((current) => ({ ...current, [provider]: event.target.value }))}
                  maxLength={80} autoComplete="off" spellCheck={false} placeholder={provider === 'x' ? '@username' : '@telegram_username'}
                  className="game-control min-h-9 min-w-0 flex-1 bg-transparent px-2 text-xs text-[#f4e6c7] outline-none placeholder:text-[#625b50]" />
                <button type="submit" disabled={busy === provider || !drafts[provider].trim() || !changed} className="game-control game-primary shrink-0 px-3 text-xs font-bold disabled:opacity-45">
                  {linked ? 'Change' : 'Link'}
                </button>
              </div>
              {error[provider] && <p role="alert" className="mt-1 text-[11px] text-red-300">{error[provider]}</p>}
            </form>
          );
        })}
      </div>
    </section>
  );
}
