import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import '@/theme/game-select.css';

export type GameSelectOption<T extends string | number> = { value: T; label: string; badge?: string; disabled?: boolean };

type Props<T extends string | number> = {
  value: T;
  options: GameSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Custom trigger content; defaults to the selected label and a chevron. */
  children?: ReactNode;
};

const GAP = 4;
const MAX_HEIGHT = 300;

/** Themed replacement for the native select: the Android system picker breaks the dark-fantasy look. */
export function GameSelect<T extends string | number>({ value, options, onChange, ariaLabel, id, className = '', disabled, placeholder, children }: Props<T>) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [style, setStyle] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value);

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 168));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom - GAP - 8;
    const above = rect.top - GAP - 8;
    const flip = below < Math.min(MAX_HEIGHT, 160) && above > below;
    setStyle(flip
      ? { left, width, bottom: window.innerHeight - rect.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) }
      : { left, width, top: rect.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const reflow = (event: Event) => { if (!listRef.current?.contains(event.target as Node)) place(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', reflow, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [open, close, place]);

  useEffect(() => {
    if (open && active >= 0) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => { if (open) listRef.current?.focus(); }, [open]);

  const step = (from: number, delta: number) => {
    for (let index = from + delta, guard = 0; guard < options.length; index += delta, guard += 1) {
      const wrapped = (index + options.length) % options.length;
      if (!options[wrapped].disabled) return wrapped;
    }
    return from;
  };

  const openList = () => {
    if (disabled) return;
    const current = options.findIndex((option) => option.value === value && !option.disabled);
    setActive(current >= 0 ? current : step(-1, 1));
    setOpen(true);
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close();
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openList(); }
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((index) => step(index, 1)),
      ArrowUp: () => setActive((index) => step(index, -1)),
      Home: () => setActive(step(-1, 1)),
      End: () => setActive(step(options.length, -1)),
      Enter: () => pick(active),
      ' ': () => pick(active),
      Escape: () => close(),
      Tab: () => close(),
    };
    const action = keys[event.key];
    if (!action) return;
    if (event.key !== 'Tab') event.preventDefault();
    event.stopPropagation();
    action();
  };

  return <>
    <button
      ref={triggerRef}
      id={id}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      onClick={() => (open ? close(false) : openList())}
      onKeyDown={onTriggerKey}
      className={`game-select-trigger ${className}`}
    >
      {children ?? <><span className="game-select-value">{selected?.label ?? placeholder ?? ''}</span><ChevronDown size={13} aria-hidden="true" className="game-select-chevron" /></>}
    </button>
    {open && createPortal(
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        tabIndex={-1}
        onKeyDown={onListKey}
        className="game-select-list game-scrollbar"
        style={style}
      >
        {options.map((option, index) => {
          const isSelected = option.value === value;
          return <li
            key={String(option.value)}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={isSelected}
            aria-disabled={option.disabled || undefined}
            className={`game-select-option${index === active ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}`}
            onPointerEnter={() => { if (!option.disabled) setActive(index); }}
            onClick={() => pick(index)}
          >
            <span>{option.label}</span>{option.badge && <span className="game-select-option-badge">{option.badge}</span>}{isSelected && <Check size={13} aria-hidden="true" />}
          </li>;
        })}
      </ul>,
      document.body,
    )}
  </>;
}
