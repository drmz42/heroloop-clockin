import { HERO_MAP } from '@/game/heroes';
import { heroPortraitSrc } from '@/game/portraits';
import type { GameState } from '@/game/types';
import { groupNumber } from '@/game/numberFormat';

const WIDTH = 1200;
const HEIGHT = 675;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('share_image_unavailable'));
    image.src = src;
  });
}

function cover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const ratio = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / ratio;
  const sourceHeight = height / ratio;
  ctx.drawImage(image, (image.naturalWidth - sourceWidth) / 2, (image.naturalHeight - sourceHeight) / 2,
    sourceWidth, sourceHeight, x, y, width, height);
}

export async function renderPartnerQuestShareCard(state: GameState, power: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('share_image_unavailable');

  const background = await loadImage('/assets/screens/dungeon-throne-abyss-v1.webp');
  cover(ctx, background, 0, 0, WIDTH, HEIGHT);
  const shade = ctx.createLinearGradient(0, 0, WIDTH, 0);
  shade.addColorStop(0, 'rgba(6, 8, 13, .96)');
  shade.addColorStop(.7, 'rgba(6, 8, 13, .68)');
  shade.addColorStop(1, 'rgba(6, 8, 13, .48)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = '#a98446';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, WIDTH - 40, HEIGHT - 40);

  ctx.fillStyle = '#e9d9b2';
  ctx.font = 'bold 26px Georgia, serif';
  ctx.fillText('HEROLOOP', 55, 73);
  ctx.fillStyle = '#a98446';
  ctx.font = 'bold 52px Georgia, serif';
  ctx.fillText('MY HERO SQUAD', 55, 142);
  ctx.fillStyle = '#f4e8d2';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.fillText((state.username || 'Hero').slice(0, 28), 58, 195);

  const heroes = state.team.slice(0, 3).map((uid) => state.ownedHeroes.find((hero) => hero.uid === uid))
    .filter((hero): hero is NonNullable<typeof hero> => Boolean(hero));
  for (const [index, hero] of heroes.entries()) {
    const base = HERO_MAP[hero.heroId];
    if (!base) continue;
    const x = 55 + index * 202;
    const y = 230;
    ctx.fillStyle = '#111019';
    ctx.fillRect(x, y, 180, 230);
    try {
      const portrait = await loadImage(heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color));
      cover(ctx, portrait, x + 3, y + 3, 174, 177);
    } catch {
      // A missing portrait must not block the player's share card.
    }
    ctx.strokeStyle = '#a98446';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 180, 230);
    ctx.fillStyle = '#f4e8d2';
    ctx.font = 'bold 19px Georgia, serif';
    ctx.fillText(base.name.slice(0, 15), x + 9, y + 207, 162);
  }

  ctx.fillStyle = '#e9d9b2';
  ctx.font = 'bold 25px Georgia, serif';
  ctx.fillText(`POWER  ${groupNumber(Math.max(0, Math.floor(power)))}`, 55, 515);
  ctx.fillText(`LOCATION  ${Math.max(1, Math.floor(state.currentLocation))}`, 55, 552);
  ctx.fillText(`GOLD EARNED  ${groupNumber(Math.max(0, Math.floor(state.totalGoldEarned)))}`, 55, 589);
  const referral = /^[A-Z2-9]{6}$/.test(state.referral.code) ? `?ref=${state.referral.code}` : '';
  ctx.fillStyle = '#c9ab72';
  ctx.font = 'bold 21px Georgia, serif';
  ctx.fillText(`heroloop.xyz/${referral}`, 55, 625);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('share_image_unavailable')), 'image/png');
  });
}
