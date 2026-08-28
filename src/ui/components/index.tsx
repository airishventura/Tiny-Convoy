/**
 * Interface primitives.
 *
 * Small, unopinionated, and shared by every screen so the game reads as one
 * object rather than a stack of pages. Buttons make a sound; nothing else does.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { audio } from '@/game/audio/AudioManager';
import { clamp01 } from '@/lib/math';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-ember text-ink border-ember hover:bg-ember-soft hover:border-ember-soft shadow-[0_10px_30px_-12px_rgba(217,122,52,0.85)]',
  secondary: 'bg-panel-2 text-cream border-line hover:border-sand/50 hover:bg-line-soft',
  ghost: 'bg-transparent text-sand border-transparent hover:text-cream hover:bg-panel-2',
  danger: 'bg-transparent text-danger border-danger/40 hover:bg-danger/10',
};

const SIZES: Record<Size, string> = {
  sm: 'text-xs px-3 py-1.5 gap-1.5 rounded-lg',
  md: 'text-sm px-4 py-2.5 gap-2 rounded-xl',
  lg: 'text-base px-7 py-3.5 gap-2.5 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, full, className = '', onClick, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      {...rest}
      onClick={(e) => {
        audio.ui(variant === 'primary' ? 'confirm' : variant === 'danger' ? 'error' : 'click');
        onClick?.(e);
      }}
      className={[
        'inline-flex items-center justify-center border font-medium transition-all duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        'active:translate-y-px',
        VARIANTS[variant],
        SIZES[size],
        full ? 'w-full' : '',
        className,
      ].join(' ')}
    >
      {icon}
      {children}
    </button>
  );
});

export const Panel = ({
  children,
  className = '',
  as: As = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'aside';
}) => <As className={`panel grain relative ${className}`}>{children}</As>;

export const Label = ({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) => (
  <div id={id} className={`label ${className}`}>
    {children}
  </div>
);

export const Stat = ({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'danger';
}) => {
  const toneClass =
    tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-cream';
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className={`mt-1 truncate text-xl font-semibold tabular ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
};

export interface MeterProps {
  /** 0..1 */
  value: number;
  label?: string;
  /** Shown at the right of the label row. */
  readout?: ReactNode;
  tone?: 'ember' | 'good' | 'warn' | 'danger' | 'sand';
  size?: 'sm' | 'md';
  className?: string;
}

const METER_TONE: Record<NonNullable<MeterProps['tone']>, string> = {
  ember: 'bg-ember',
  good: 'bg-good',
  warn: 'bg-warn',
  danger: 'bg-danger',
  sand: 'bg-sand',
};

export const Meter = ({ value, label, readout, tone = 'ember', size = 'md', className = '' }: MeterProps) => {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className={className}>
      {(label || readout) && (
        <div className="mb-1 flex items-baseline justify-between gap-3">
          {label && <Label>{label}</Label>}
          {readout && <div className="text-xs tabular text-sand">{readout}</div>}
        </div>
      )}
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={typeof readout === 'string' ? readout : `${pct}%`}
        className={`w-full overflow-hidden rounded-full bg-ink/70 ring-1 ring-cream/8 ${size === 'sm' ? 'h-1.5' : 'h-2.5'}`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-out ${METER_TONE[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

export const Divider = ({ className = '' }: { className?: string }) => (
  <div className={`h-px w-full bg-line ${className}`} />
);

export const Badge = ({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ember' | 'good' | 'warn' | 'danger';
}) => {
  const tones = {
    neutral: 'border-line text-sand',
    ember: 'border-ember/50 text-ember-soft',
    good: 'border-good/50 text-good',
    warn: 'border-warn/50 text-warn',
    danger: 'border-danger/50 text-danger',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.68rem] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
};

export const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[0.68rem] text-sand">
    {children}
  </kbd>
);

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Focus containment for a modal-like overlay: focuses the panel (or its first
 * focusable child) when it becomes active, traps Tab inside it, and hands
 * focus back to whatever had it before on close. Registered on `document` in
 * the capture phase — the input manager listens on `window` and swallows Tab
 * for the convoy overview, so a bubble-phase trap would never see the key
 * while the pause menu has the game running behind it.
 *
 * Escape is deliberately not handled here: callers that close on Escape (like
 * `Modal`) wire their own listener, since what Escape *does* varies by caller
 * and this hook only owns focus.
 */
export const useFocusTrap = <T extends HTMLElement>(active: boolean, panelRef: RefObject<T | null>): void => {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      e.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? index - 1 : index + 1;
      items[(next + items.length) % items.length].focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.();
    };
  }, [active, panelRef]);
};

/**
 * Modal.
 *
 * A real dialog: labelled, focus-trapped via `useFocusTrap`, Escape-closable,
 * and it hands focus back where it came from.
 */
export const Modal = ({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose?: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useFocusTrap(open, panelRef);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
      <div aria-hidden className="absolute inset-0 bg-ink/72 backdrop-blur-sm" onClick={onClose} />
      <Panel className={`relative flex max-h-[92vh] w-full flex-col ${width} rise-in overflow-hidden`}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col outline-none"
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3.5">
            <h2 id={titleId} className="min-w-0 truncate text-base">
              {title}
            </h2>
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose} aria-label={`Close ${typeof title === 'string' ? title : 'panel'}`}>
                Esc
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar px-5 py-4">{children}</div>
          {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
        </div>
      </Panel>
    </div>
  );
};

export const EmptyState = ({ title, body, action }: { title: string; body: string; action?: ReactNode }) => (
  <div role="status" className="flex flex-col items-center gap-3 px-5 py-10 text-center">
    <div className="text-sm font-medium text-sand">{title}</div>
    <p className="max-w-sm text-xs leading-relaxed text-muted">{body}</p>
    {action}
  </div>
);

/**
 * The one place offline notes, soft failures and hard errors are written, so
 * "we could not reach the server" looks the same wherever it happens.
 */
export const Notice = ({
  tone = 'info',
  children,
  action,
  className = '',
}: {
  tone?: 'info' | 'warn' | 'danger' | 'good';
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) => {
  const tones = {
    info: 'border-line text-muted',
    warn: 'border-warn/40 text-warn',
    danger: 'border-danger/45 text-danger',
    good: 'border-good/40 text-good',
  };
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-panel-2/60 px-3 py-2.5 text-xs leading-relaxed ${tones[tone]} ${className}`}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
};

export const Spinner = ({ label }: { label?: string }) => (
  <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted">
    <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line border-t-ember" />
    {label ?? <span className="sr-only">Loading</span>}
  </div>
);
