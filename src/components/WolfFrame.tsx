/** Location 2 wolf study: bone and iron pieces physically joined to the card. */
export function WolfFrame() {
  return <svg className="enemy-wolf-frame" viewBox="0 0 94 122" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="wolf-frame-iron" x2="0" y2="1"><stop stopColor="#91877a"/><stop offset=".4" stopColor="#3a332f"/><stop offset="1" stopColor="#17181a"/></linearGradient>
      <linearGradient id="wolf-frame-bone" x2="0" y2="1"><stop stopColor="#eee2cb"/><stop offset=".5" stopColor="#b7aa94"/><stop offset="1" stopColor="#685f53"/></linearGradient>
      <linearGradient id="wolf-frame-cloth" x2="1" y2="1"><stop stopColor="#842c25"/><stop offset="1" stopColor="#2c0909"/></linearGradient>
    </defs>
    <path d="M5 31V13Q5 5 13 5H78Q87 5 87 14V30L82 25V15Q82 10 77 10H15Q10 10 10 15V26Z" fill="url(#wolf-frame-iron)" stroke="#867663" strokeWidth="1.4"/>
    <path d="M6 96V108Q6 117 15 117H30L24 113H15Q11 113 11 108V100ZM87 96V108Q87 117 78 117H63L69 113H78Q82 113 82 108V100Z" fill="url(#wolf-frame-iron)" stroke="#867663" strokeWidth="1.4"/>
    <path d="M16 14Q25 9 37 10L45 12Q49 12 56 9Q68 9 78 15L75 18Q65 14 57 15L47 17L36 15Q26 14 19 18Z" fill="url(#wolf-frame-bone)" stroke="#43362d" strokeWidth="1.5"/>
    <path d="M25 12L21 17M68 12L73 17M37 12L36 15M57 12L58 15" stroke="#6a5c4d" strokeWidth="1"/>
    <path d="M10 17Q6 24 8 36L12 41L14 32L13 24L18 19Z M84 17Q88 24 85 36L82 42L79 32L80 24L75 19Z" fill="url(#wolf-frame-bone)" stroke="#42342b" strokeWidth="1.3"/>
    <path d="M9 30L13 35L14 30M85 30L81 35L80 30" fill="none" stroke="#eee1c7" strokeWidth="1"/>
    <path d="M13 24L16 26L15 38L12 43L12 33Z" fill="url(#wolf-frame-cloth)" stroke="#8e4a3a" strokeWidth=".8"/>
    <g fill="url(#wolf-frame-bone)" stroke="#40352e" strokeWidth="1.1">
      <path d="M4 5L12 3L21 9L19 13L11 9L7 16L5 14Z"/>
      <path d="M74 8Q76 1 84 2Q91 3 91 10Q91 15 87 17L87 21H78L78 17Q73 14 74 8Z"/>
      <path d="M4 106Q4 99 11 98Q18 98 20 104Q20 108 17 111L17 116H8L8 111Q4 109 4 106Z"/>
      <path d="M88 101L90 108L85 117L75 120L72 116L82 111L84 102Z"/>
    </g>
    <g fill="#171819"><ellipse cx="79" cy="10" rx="2" ry="2.3"/><ellipse cx="86" cy="10" rx="2" ry="2.3"/><ellipse cx="9" cy="105" rx="2" ry="2.3"/><ellipse cx="16" cy="105" rx="2" ry="2.3"/></g>
    <g fill="#221d1a"><path d="M81 15L82.5 12L84 15ZM11 110L12.5 107L14 110Z"/></g>
    <g stroke="#564939" strokeWidth=".8"><path d="M79 21V17M82 21V17M85 21V17M10 116V112M13 116V112M16 116V112"/></g>
    <path d="M18 112L27 116L31 120L24 118M76 112L67 116L63 120L70 118" fill="url(#wolf-frame-bone)" stroke="#493b32" strokeWidth="1"/>
  </svg>;
}
