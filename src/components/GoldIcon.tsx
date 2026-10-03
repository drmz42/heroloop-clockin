/** The same gold coin used by the Android balance header. */
export function GoldIcon({ size = 12 }: { size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size, flexShrink: 0, display: 'inline-block', border: '1px solid rgba(253,230,138,.7)', borderRadius: '50%', background: 'radial-gradient(circle at 35% 30%, #fff1a5 0%, #e8ad21 38%, #89520a 78%)', boxShadow: '0 0 7px rgba(245,184,45,.55)' }} />;
}
