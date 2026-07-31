import { X, Zap, Send, Twitter, MessageCircle, Coins, TrendingUp, Package, Star, Crown, CheckCircle2, Circle } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { GameApi } from '@/game/useGame';

export function BoostMaxModal({ game, onClose }: { game: GameApi; onClose: () => void }) {
  const { state } = game;
  const c = state.boost.conditions;
  const active = state.boost.active;

  const tasks = [
    { key: 'connectTelegram' as const, label: 'Join Telegram', icon: <Send size={16} />, done: c.connectTelegram },
    { key: 'connectTwitter' as const,  label: 'Follow Twitter', icon: <Twitter size={16} />, done: c.connectTwitter },
    { key: 'connectDiscord' as const,  label: 'Join Discord',   icon: <MessageCircle size={16} />, done: c.connectDiscord },
    { key: 'spent' as const,           label: 'Spend 500 $HERO in-game', icon: <Coins size={16} />, done: c.spentTokens >= 500, progress: Math.min(c.spentTokens, 500) },
    { key: 'hold' as const,            label: 'Hold 1000 $HERO on account', icon: <Zap size={16} />, done: c.holdTokens >= 1000 || state.hero >= 1000, progress: Math.min(state.hero, 1000) },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 anim-fade scanlines">
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto no-scrollbar px-panel-raised p-5">
        <div className="text-center mb-4">
          <div className="inline-flex items-center gap-2 mb-1">
            <Crown size={24} className="text-px-bright" />
            <h2 className="font-vt text-3xl font-bold text-gold-glow">BOOST MAX</h2>
          </div>
          <p className="font-vt text-px-dim text-base">Complete all conditions to unlock <b className="text-px-bright">+100% token income</b> and <b className="text-px-bright">24/7 offline earnings</b>.</p>
        </div>

        {/* Progress bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between font-vt text-sm mb-1">
            <span className="text-px-text font-bold">PROGRESS</span>
            <span className={`font-bold tabular-nums ${active ? 'text-px-green' : 'text-px-bright'}`}>{state.boost.progress}%</span>
          </div>
          <div className="h-4 bg-px-bg border-2 border-px-border overflow-hidden" style={{ boxShadow: '2px 2px 0 #2a1504' }}>
            <div className="h-full transition-all duration-300" style={{ width: `${state.boost.progress}%`, background: active ? 'linear-gradient(90deg,#3a8a28,#4ade80)' : 'linear-gradient(90deg,#c8840e,#f5c518)' }} />
          </div>
        </div>

        {active ? (
          <div className="mb-4 p-3 border-2 border-px-green bg-px-green/10" style={{ boxShadow: '3px 3px 0 #1a4a14' }}>
            <div className="flex items-center gap-2 text-px-green font-vt text-xl font-bold">
              <CheckCircle2 size={20} /> BOOST MAX ACTIVE
            </div>
            <div className="font-vt text-px-text text-sm mt-1.5 space-y-0.5">
              <div className="flex items-center gap-1"><TrendingUp size={13} className="text-px-green" /> +100% $HERO token income on locations</div>
              <div className="flex items-center gap-1"><Package size={13} className="text-px-green" /> 24/7 offline gold, tokens, XP & chests</div>
              <div className="flex items-center gap-1"><Star size={13} className="text-px-green" /> No 8-hour cap — earnings never stop</div>
            </div>
            <button onClick={game.deactivateBoost} className="w-full mt-2 py-1.5 px-btn text-sm font-bold">DISABLE BOOST</button>
          </div>
        ) : (
          <div className="space-y-2 mb-4">
            {tasks.map((t) => (
              <div key={t.key} className="flex items-center gap-2.5 p-2.5 px-panel border-2" style={{ borderColor: t.done ? '#3a8a28' : '#5c3f08', boxShadow: '2px 2px 0 #2a1504' }}>
                <div className={`w-9 h-9 flex items-center justify-center border-2 ${t.done ? 'border-px-green text-px-green' : 'border-px-border text-px-dim'}`} style={{ background: t.done ? '#2a6a1833' : '#0c0800' }}>
                  {t.icon}
                </div>
                <div className="flex-1">
                  <div className="font-vt text-base font-bold" style={{ color: t.done ? '#4ade80' : '#f0d060' }}>{t.label}</div>
                  {'progress' in t && t.progress !== undefined && !t.done && (
                    <div className="h-1.5 bg-px-bg border border-px-border overflow-hidden mt-1">
                      <div className="h-full bg-px-gold" style={{ width: `${(t.progress / 500) * 100}%` }} />
                    </div>
                  )}
                </div>
                {t.done ? (
                  <CheckCircle2 size={20} className="text-px-green" />
                ) : t.key === 'connectTelegram' || t.key === 'connectTwitter' || t.key === 'connectDiscord' ? (
                  <button onClick={() => game.toggleBoostCondition(t.key)} className="px-2.5 py-1 px-btn text-sm font-bold">CONNECT</button>
                ) : (
                  <Circle size={18} className="text-px-dim" />
                )}
              </div>
            ))}
          </div>
        )}

        {!active && (
          <div className="px-panel p-3 mb-3 border-2 border-px-border">
            <div className="font-vt text-px-bright text-base font-bold mb-1.5">REWARDS AT 100%</div>
            <ul className="font-vt text-px-text text-sm space-y-1">
              <li className="flex items-center gap-2"><Zap size={14} className="text-purple-300" /> +100% $HERO tokens per battle</li>
              <li className="flex items-center gap-2"><TrendingUp size={14} className="text-px-green" /> 24/7 offline earnings (no 8h cap)</li>
              <li className="flex items-center gap-2"><Package size={14} className="text-px-bright" /> Chests, gold, XP & tokens while away</li>
            </ul>
          </div>
        )}

        <button onClick={game.activateBoost} className="w-full py-3 px-btn text-lg font-bold flex items-center justify-center gap-2">
          <Crown size={18} /> {active ? 'REFRESH BOOST' : 'CHECK PROGRESS'}
        </button>

        <button onClick={onClose} className="absolute -top-2 -right-2 p-1.5 bg-px-panel border-2 border-px-border">
          <X size={16} className="text-px-text" />
        </button>
      </div>
    </div>
  );
}
