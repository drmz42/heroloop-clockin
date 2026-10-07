const motionActive = () =>
  document.documentElement.dataset.hlMotion === 'on'
  && !document.querySelector('.game-motion-off')
  && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Sale feedback: a few coins fly from the sold item (or Sell button) into the gold counter.
export function flyCoins(from: Element | null | undefined) {
  if (!from || typeof document === 'undefined' || !motionActive()) return;
  const target = document.querySelector('.tb-coin') ?? document.querySelector('.hl-nav-right');
  if (!target) return;
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const sx = a.left + a.width / 2;
  const sy = a.top + a.height / 2;
  const dx = b.left + b.width / 2 - sx;
  const dy = b.top + b.height / 2 - sy;
  for (let index = 0; index < 7; index++) {
    const coin = document.createElement('span');
    coin.className = 'hl-mo-coin';
    coin.style.left = `${sx}px`;
    coin.style.top = `${sy}px`;
    document.body.appendChild(coin);
    const spreadX = (index - 3) * 9 + (Math.random() - .5) * 10;
    const spreadY = -18 - Math.random() * 26;
    const animation = coin.animate([
      { transform: 'translate(-50%, -50%) scale(.4)', opacity: 0 },
      { transform: `translate(calc(-50% + ${spreadX}px), calc(-50% + ${spreadY}px)) scale(1.1)`, opacity: 1, offset: .28 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.55)`, opacity: .9 },
    ], { duration: 720 + index * 55, delay: index * 35, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'backwards' });
    animation.onfinish = () => coin.remove();
    animation.oncancel = () => coin.remove();
  }
}
