import { useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  pendingLabel?: ReactNode;
};

/** Keep server-confirmed actions responsive without submitting the same press twice. */
export function AsyncActionButton({ onClick, disabled, children, style, pendingLabel = 'Wait…', ...props }: Props) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ minWidth: number; minHeight: number }>();
  return <button {...props} type={props.type ?? 'button'} disabled={disabled || pending}
    aria-busy={pending || props['aria-busy']} aria-live="polite"
    style={{ ...style, ...((pending || failed) ? size : undefined) }}
    title={failed ? 'Action failed. Tap to retry.' : props.title}
    onClick={async (event) => {
      if (running.current || disabled) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      setSize({ minWidth: bounds.width, minHeight: bounds.height });
      running.current = true;
      setFailed(false);
      setPending(true);
      try {
        await onClick?.(event);
      } catch {
        setFailed(true);
      } finally {
        running.current = false;
        setPending(false);
      }
    }}>{pending ? pendingLabel : failed ? 'Retry' : children}</button>;
}
