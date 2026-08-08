export function FantasyBagIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8 5.5c1.1.7 2.45 1.05 4 1.05s2.9-.35 4-1.05l-1.15-2.3H9.15L8 5.5Z" fill="currentColor" opacity=".38" />
      <path d="M8 5.5c1.1.7 2.45 1.05 4 1.05s2.9-.35 4-1.05M9.15 3.2h5.7L16 5.5c3.05 2.1 4.3 5.1 4.3 9.2 0 4.25-2.65 6.1-8.3 6.1s-8.3-1.85-8.3-6.1C3.7 10.6 4.95 7.6 8 5.5l1.15-2.3Z" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.35 9.2c3.75 1.05 7.55 1.05 11.3 0M8.35 6.15l-1.2 3.45m8.5-3.45 1.2 3.45" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M9.2 13.15c1.9-.8 3.7-.8 5.6 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".72" />
    </svg>
  );
}
