import { Zap, MessageCircle, BookOpen, LogOut, Globe, Send, Twitter } from 'lucide-react';
import { useState } from 'react';
import type { GameApi } from '@/game/useGame';

export function FooterBar({ game }: { game: GameApi }) {
  const [copied, setCopied] = useState(false);
  const tokenCA = 'HERO...p7Xq9M'; // placeholder contract address

  const copyCA = () => {
    navigator.clipboard?.writeText(tokenCA).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const logout = () => {
    game.setUserProfile('', '');
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-px-panel border-t-2 border-px-border shrink-0 text-sm overflow-x-auto no-scrollbar">
      {/* Token contract */}
      <button onClick={copyCA} className="flex items-center gap-1 px-2 py-1 border-2 border-purple-700/60 bg-px-panel2 hover:border-purple-500 transition-none font-vt whitespace-nowrap" title="Copy token contract">
        <Zap size={13} className="text-purple-300" />
        <span className="text-px-dim text-xs">CA:</span>
        <span className="text-purple-200 font-bold text-xs">{copied ? 'COPIED!' : tokenCA}</span>
      </button>

      <div className="w-px h-4 bg-px-border mx-0.5" />

      {/* Socials */}
      <FooterLink icon={<Send size={13} />} label="Telegram" href="#" />
      <FooterLink icon={<Twitter size={13} />} label="Twitter" href="#" />
      <FooterLink icon={<MessageCircle size={13} />} label="Discord" href="#" />
      <FooterLink icon={<Globe size={13} />} label="Website" href="#" />
      <FooterLink icon={<BookOpen size={13} />} label="Guides" href="#" />

      <div className="flex-1" />

      {/* Support + logout */}
      <FooterLink icon={<MessageCircle size={13} />} label="Support" href="#" />
      <button onClick={logout} className="flex items-center gap-1 px-2 py-1 border-2 border-px-border bg-px-panel2 hover:border-px-red transition-none font-vt text-sm text-px-dim hover:text-px-red whitespace-nowrap">
        <LogOut size={13} /> Logout
      </button>
    </div>
  );
}

function FooterLink({ icon, label, href }: { icon: React.ReactNode; label: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 border-2 border-transparent hover:border-px-border hover:bg-px-panel2 transition-none font-vt text-sm text-px-dim hover:text-px-text whitespace-nowrap">
      {icon} <span className="hidden sm:inline">{label}</span>
    </a>
  );
}
