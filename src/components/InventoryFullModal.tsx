import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Package } from 'lucide-react';

export function InventoryFullModal({ onClose }: { onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        button.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[10030] grid place-items-center bg-black/75 p-4" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="inventory-full-title" aria-describedby="inventory-full-description" className="material-panel w-full max-w-sm rounded-xl border border-[#80683f] p-5 text-center shadow-2xl">
        <Package size={32} className="mx-auto mb-3 text-[#f0c563]" aria-hidden="true" />
        <h2 id="inventory-full-title" className="ui-text-large font-black text-[#f0dfba]">Inventory full</h2>
        <p id="inventory-full-description" className="mt-2 text-sm leading-6 text-[#c9c2b6]">Free up space in your equipment bags before opening chests.</p>
        <button ref={button} type="button" onClick={onClose} className="game-control game-primary mt-4 min-h-11 w-full px-4 text-sm font-bold">OK</button>
      </section>
    </div>, document.body,
  );
}
