import { useState } from 'react';
import { useGame } from '@/game/useGame';

export function LoginScreen({ game }: { game: ReturnType<typeof useGame> }) {
  const [username, setUsername] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [refCode, setRefCode] = useState('');

  const connect = (walletType: string) => {
    setConnecting(true);
    setTimeout(() => {
      const fakeAddr = walletType === 'guest'
        ? 'guest-' + Math.random().toString(36).slice(2, 10)
        : [Math.random().toString(36).slice(2, 6), Math.random().toString(36).slice(2, 6), Math.random().toString(36).slice(2, 6)].join('...') + Math.random().toString(36).slice(2, 4);
      const name = username.trim() || 'player' + Math.floor(Math.random() * 999);
      game.setUserProfile(name, fakeAddr);
      setConnecting(false);
    }, 1200);
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen bg-px-bg scanlines crt-vignette px-4">
      <div className="relative w-full max-w-sm">
        {/* Logo block */}
        <div className="text-center mb-6">
          <div className="inline-block w-16 h-16 bg-px-gold border-2 border-px-bright mb-3 anim-bob" style={{ boxShadow: '4px 4px 0 #3d2008' }}>
            <div className="w-full h-full flex items-center justify-center font-pixel text-2xl text-px-bg">H</div>
          </div>
          <h1 className="font-pixel text-lg text-gold-glow anim-flicker mb-1">HeroLoop</h1>
          <p className="font-vt text-px-dim text-sm">AFK CRYPTO RPG ON SOLANA</p>
        </div>

        {/* Panel */}
        <div className="px-panel-raised p-5 scanlines">
          <div className="mb-4">
            <label className="font-vt text-px-dim text-sm block mb-1">YOUR NAME</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.slice(0, 16))}
              placeholder="enter hero name..."
              className="w-full px-3 py-2 bg-px-bg border-2 border-px-border text-px-text font-vt text-lg focus:outline-none focus:border-px-bright"
            />
          </div>

          <div className="mb-4">
            <label className="font-vt text-px-dim text-sm block mb-1">REFERRAL CODE (optional)</label>
            <input
              value={refCode}
              onChange={(e) => setRefCode(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="ABC123..."
              className="w-full px-3 py-2 bg-px-bg border-2 border-px-border text-px-text font-vt text-lg focus:outline-none focus:border-px-bright uppercase tracking-widest"
            />
          </div>

          {connecting ? (
            <div className="text-center py-4">
              <div className="font-pixel text-[10px] text-px-bright anim-jitter">CONNECTING<span className="px-cursor" /></div>
              <div className="mt-2 flex justify-center gap-1">
                {[0,1,2].map(i => <div key={i} className="w-2 h-2 bg-px-gold anim-bob" style={{ animationDelay: `${i*0.15}s` }} />)}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                onClick={() => connect('phantom')}
                className="w-full py-3 px-btn text-base font-bold flex items-center justify-center gap-2"
              >
                <span className="w-5 h-5 bg-purple-500 border border-purple-300 inline-block" />
                CONNECT PHANTOM
              </button>
              <button
                onClick={() => connect('solflare')}
                className="w-full py-2.5 px-btn text-sm font-bold flex items-center justify-center gap-2"
              >
                <span className="w-4 h-4 bg-orange-500 border border-orange-300 inline-block" />
                CONNECT SOLFLARE
              </button>
              <button
                onClick={() => connect('guest')}
                className="w-full py-2 px-btn text-sm font-bold opacity-70"
              >
                PLAY AS GUEST
              </button>
            </div>
          )}
        </div>

        <p className="text-center font-vt text-px-dim text-xs mt-4">
          testnet — no real transactions yet
        </p>
      </div>
    </div>
  );
}
