import { useMemo, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';

type GuideStatus = 'Live' | 'Coming soon';

interface GuideEntry {
  category: string;
  question: string;
  answer: string;
  status: GuideStatus;
}

const GUIDES: GuideEntry[] = [
  { category: 'Getting Started', question: 'How is my progress saved?', answer: 'Your registered account loads and saves game progress through the server. Use the same authenticated account when you return.', status: 'Live' },
  { category: 'Getting Started', question: 'What happens while I am away?', answer: 'Offline progress uses your last farming location and active formation. Ordinary sessions have a limited offline reward window; active Boost Max removes that window cap.', status: 'Live' },
  { category: 'Heroes', question: 'How many heroes can fight?', answer: 'Your Active Formation supports up to three heroes. Each hero fights in one lane and keeps individual HP, level, stars, stats and equipment.', status: 'Live' },
  { category: 'Heroes', question: 'Which classes are available?', answer: 'Warrior, Mage, Assassin, Druid and Crossbowman are available. Their fixed weapon pairs are Sword + Shield, Arcane Staff + Spellbook, Dagger + Throwing Weapons, Nature Staff + Totem, and Crossbow + Quiver.', status: 'Live' },
  { category: 'Heroes', question: 'How does Ascension work?', answer: 'Ascension consumes eligible exact duplicate heroes and $HERO to add stars. Active, locked, trained or progressed copies are protected from consumption.', status: 'Live' },
  { category: 'Items', question: 'What equipment can a hero wear?', answer: 'Each active hero has eight slots: Class Weapon, Off-hand, Helmet, Chest, Gloves, Boots, Ring and Amulet. Class Weapon and Off-hand must match the hero class.', status: 'Live' },
  { category: 'Items', question: 'How does a Set Bonus work?', answer: 'Equip all eight slots with one rarity to increase every stat granted by those equipped items. The bonus does not multiply the hero\'s base stats.', status: 'Live' },
  { category: 'Items', question: 'What does Item Power measure?', answer: 'Item Power scores the item\'s rolled stats and Enchant level. Rarity and Item Level affect the generated values, so two items with the same name can have different Power.', status: 'Live' },
  { category: 'Combat', question: 'Is Recommended Power a requirement?', answer: 'No. Recommended Power is guidance for the selected location and formation size. Account Level and discovered progression control location access.', status: 'Live' },
  { category: 'Combat', question: 'How do Bosses and chests work?', answer: 'A Boss summon consumes one Boss Key. A Boss Chest is awarded after that summoned Boss is defeated. Standard and Boss Chests award server-rolled equipment when opened.', status: 'Live' },
  { category: 'Economy', question: 'What are Gold and $HERO used for?', answer: 'Gold supports current game upgrades and purchases. $HERO is used by supported server-settled systems such as Summon, Ascension, guaranteed Enchant and Reroll.', status: 'Live' },
  { category: 'Economy', question: 'How does Summon Pity work?', answer: 'Pity counters track consecutive misses for protected rarity bands. A qualifying result resets its counter and every lower counter; the guarantees repeat.', status: 'Live' },
  { category: 'Features', question: 'What is available in the Market?', answer: 'Legendary-or-higher wearable equipment can be listed, bought and cancelled through server escrow. Locked or equipped items cannot be listed.', status: 'Live' },
  { category: 'Features', question: 'Are Crafting, Salvage, Pets, Spells and Auras available?', answer: 'Not yet. Their controls or placeholders may be visible, but no undefined recipe, reward or bonus is active.', status: 'Coming soon' },
  { category: 'Accessibility', question: 'Can I reduce battle motion?', answer: 'Yes. Battle animation modes include Light, Spectacular and Off. System Reduced Motion also suppresses nonessential effects.', status: 'Live' },
];

const CATEGORIES = ['All', ...Array.from(new Set(GUIDES.map((entry) => entry.category)))];

export function GuidesScreen() {
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return GUIDES.filter((entry) => (category === 'All' || entry.category === category)
      && (!search || `${entry.question} ${entry.answer}`.toLowerCase().includes(search)));
  }, [category, query]);

  return (
    <div className="premium-screen min-h-full p-4 sm:p-6">
      <header className="pr-12">
        <div className="section-kicker flex items-center gap-2"><BookOpen size={15} /> HeroLoop Guides</div>
        <h1 className="mt-1 font-vt text-2xl font-black text-[#f0dfbb]">Wiki &amp; FAQ</h1>
        <p className="mt-1 max-w-2xl text-sm text-[#aaa193]">Current player rules and concise answers. Planned systems are clearly marked and never presented as live.</p>
      </header>

      <label className="game-control mt-4 flex h-10 items-center gap-2 px-3">
        <Search size={15} className="text-[#a68d62]" aria-hidden="true" />
        <span className="sr-only">Search guides</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guides…" className="min-w-0 flex-1 bg-transparent text-sm text-[#eee5d5] outline-none placeholder:text-[#6f6a61]" />
      </label>

      <div className="mt-4 grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav className="no-scrollbar flex gap-1 overflow-x-auto md:flex-col" aria-label="Guide categories">
          {CATEGORIES.map((item) => (
            <button key={item} type="button" onClick={() => setCategory(item)} className={`game-control shrink-0 px-3 py-2 text-left text-xs font-bold ${category === item ? 'game-primary' : ''}`} aria-pressed={category === item}>{item}</button>
          ))}
        </nav>

        <section className="min-w-0 space-y-2" aria-live="polite">
          {filtered.map((entry) => (
            <details key={entry.question} className="group rounded-lg border border-[#55452e] bg-[#11130f]/90 open:border-[#96703a]">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 text-sm font-bold text-[#e9dfcd]">
                <span className="min-w-0 flex-1">{entry.question}</span>
                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${entry.status === 'Live' ? 'border-emerald-700/60 text-emerald-300' : 'border-amber-700/60 text-amber-300'}`}>{entry.status}</span>
                <span className="text-[#b8975c] transition-transform group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <p className="border-t border-[#443824] px-3 py-3 text-sm leading-relaxed text-[#bdb4a5]">{entry.answer}</p>
            </details>
          ))}
          {filtered.length === 0 && <div className="intentional-empty rounded-lg p-6 text-center text-sm">No guide matches your search.</div>}
        </section>
      </div>
    </div>
  );
}
