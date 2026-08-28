/**
 * Toasts.
 *
 * Short, warm, and gone in a few seconds. They report what happened; they never
 * tell the player what to press — that is the interaction prompt's job.
 *
 * The region is polite and permanent: it stays mounted even when empty so a
 * screen reader has something to watch, and announces additions rather than
 * re-reading the whole stack.
 */

import { memo, useEffect } from 'react';
import { useHud, type ToastTone } from '@/state/useHud';

const TONES: Record<ToastTone, string> = {
  info: 'border-line text-sand',
  good: 'border-good/50 text-good',
  warn: 'border-warn/50 text-warn',
  danger: 'border-danger/55 text-danger',
};

const LIFETIME = 4200;

export const Toasts = memo(function Toasts() {
  const toasts = useHud((s) => s.toasts);
  const dismiss = useHud((s) => s.dismiss);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => window.setTimeout(() => dismiss(t.id), Math.max(600, LIFETIME - (performance.now() - t.at))));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, dismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none absolute left-1/2 top-5 z-30 flex w-[min(22rem,90vw)] -translate-x-1/2 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div key={t.id} className={`hud-chip border px-3.5 py-2 rise-in ${TONES[t.tone]}`}>
          <div className="text-xs font-semibold">{t.title}</div>
          {t.body && <div className="mt-0.5 text-[0.72rem] leading-snug text-sand">{t.body}</div>}
        </div>
      ))}
    </div>
  );
});
