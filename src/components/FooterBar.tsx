import { isolatedHackathon } from '@/game/editionStorage';
import { MessageCircle, BookOpen, KeyRound, LogOut, Globe, Send, Twitter } from 'lucide-react';
import { useState } from 'react';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { defaultUiTheme, setUiTheme } from '@/theme/uiTheme';

export function FooterBar({ onLogout, onGuidesClick, onCodeClick, onSupportClick }: { onLogout: () => void; onGuidesClick: () => void; onCodeClick: () => void; onSupportClick: () => void }) {
  const [copied, setCopied] = useState(false);
  const tokenCA = isolatedHackathon ? 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3' : 'HERO...p7Xq9M'; // placeholder contract address

  const copyCA = () => {
    navigator.clipboard?.writeText(tokenCA).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="game-footer flex min-h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-[#51422e] bg-[linear-gradient(180deg,#181815,#0d0f0e)] px-2 py-1 text-xs shadow-[0_-8px_24px_rgba(0,0,0,.24)] no-scrollbar">
      {/* Token contract */}
      <button onClick={copyCA} className="game-control flex min-h-7 items-center gap-1 whitespace-nowrap px-2 py-1 font-vt" title="Copy token contract">
        <HeroTokenIcon size={13} />
        <span className="text-px-dim text-xs">CA:</span>
        <span className="text-purple-200 font-bold text-xs">{copied ? 'COPIED!' : isolatedHackathon ? `${tokenCA.slice(0,4)}…${tokenCA.slice(-4)}` : tokenCA}</span>
      </button>

      <div className="w-px h-4 bg-px-border mx-0.5" />

      {/* Socials */}
      <FooterLink icon={<Send size={13} />} label="Telegram" href="#" />
      <FooterLink icon={<Twitter size={13} />} label="Twitter" href="#" />
      <FooterLink icon={<MessageCircle size={13} />} label="Discord" href="#" />
      <FooterLink icon={<Globe size={13} />} label="Website" href="#" />
      <FooterLink icon={<BookOpen size={13} />} label="Guides" href="/wiki" target="_self" onClick={(event) => { event.preventDefault(); onGuidesClick(); }} />
      <button type="button" onClick={onCodeClick} className="game-control flex min-h-7 items-center gap-1 whitespace-nowrap px-2 py-1 font-vt text-xs">
        <KeyRound size={13} /> Code
      </button>

      <div className="mx-1 h-5 w-px bg-px-border" />

      <div className="flex-1" />

      {/* Staging2 visual lab: compare or roll back the premium skin on this browser */}
      {defaultUiTheme === 'premium' && (
        <button type="button" onClick={() => setUiTheme(document.documentElement.dataset.hlTheme === 'premium' ? 'classic' : 'premium')} className="game-control flex min-h-7 items-center gap-1 whitespace-nowrap px-2 py-1 font-vt text-xs">
          {document.documentElement.dataset.hlTheme === 'premium' ? 'Classic UI' : 'Premium UI'}
        </button>
      )}
      {/* Support + logout; the account nickname is not shown here */}
      <button type="button" onClick={onSupportClick} className="game-control flex min-h-7 items-center gap-1 whitespace-nowrap px-2 py-1 font-vt text-xs"><MessageCircle size={13} /> Support</button>
      <button onClick={onLogout} className="game-control game-danger flex min-h-7 items-center gap-1 whitespace-nowrap px-2 py-1 font-vt text-xs">
        <LogOut size={13} /> Logout
      </button>
    </div>
  );
}

function FooterLink({ icon, label, href, target = '_blank', onClick }: { icon: React.ReactNode; label: string; href: string; target?: React.HTMLAttributeAnchorTarget; onClick?: React.MouseEventHandler<HTMLAnchorElement> }) {
  return (
    <a href={href} target={target} rel={target === '_blank' ? 'noopener noreferrer' : undefined} onClick={onClick} className="flex min-h-7 items-center gap-1 whitespace-nowrap rounded-md border border-transparent px-2 py-1 font-vt text-xs text-[#777870] transition hover:border-[#4d4231] hover:bg-white/[.025] hover:text-[#d6d0c4]">
      {icon} <span className="hidden sm:inline">{label}</span>
    </a>
  );
}
