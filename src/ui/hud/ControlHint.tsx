/**
 * First-drive control hint.
 *
 * The `showHints` setting existed and was never read by anything. This is what
 * it now drives: one small card, on your first drive only, next to the
 * objective where you are already looking. It leaves when you dismiss it or
 * after twenty-odd seconds of driving, and it is marked seen either way, so it
 * cannot become a thing you close every run.
 *
 * It is not a tutorial. It never blocks the road, never pauses the game, and
 * everything on it is repeated in the pause menu.
 */

import { memo, useEffect, useState } from 'react';
import { useHud } from '@/state/useHud';
import { usePlayer } from '@/state/usePlayer';
import { useSettings } from '@/state/useSettings';
import { Key } from '@/ui/components';
import { HINT_CONTROLS, controlHintFinished, controlHintVisible } from './controlHintPolicy';

export const ControlHint = memo(function ControlHint() {
  const showHints = useSettings((s) => s.showHints);
  const tutorialDone = usePlayer((s) => s.profile.tutorialDone);
  const markTutorialDone = usePlayer((s) => s.markTutorialDone);
  const elapsed = useHud((s) => s.hud.elapsed);
  const [dismissed, setDismissed] = useState(false);

  const context = { showHints, tutorialDone, dismissed, elapsed };
  const visible = controlHintVisible(context);
  const finished = controlHintFinished(context);

  // Record it as seen once, on the way out — not on mount, so a player who
  // alt-tabs away during their first five seconds still gets it next time.
  useEffect(() => {
    if (finished) markTutorialDone();
  }, [finished, markTutorialDone]);

  if (!visible) return null;

  return (
    <div className="mt-2 max-w-full">
      <div className="hud-chip px-3.5 py-3 fade-in">
        <div className="flex items-start justify-between gap-3">
          <div className="label">Controls</div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Hide the control hint"
            className="pointer-events-auto -mr-1 -mt-0.5 rounded px-1.5 py-0.5 text-[0.68rem] text-muted transition-colors hover:text-cream"
          >
            Got it
          </button>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5">
          {HINT_CONTROLS.map(([key, what]) => (
            <div key={key} className="contents">
              <dt className="justify-self-start">
                <Key>{key}</Key>
              </dt>
              <dd className="min-w-0 truncate text-[0.7rem] leading-snug text-sand">{what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2.5 text-[0.68rem] leading-snug text-muted">A gamepad works too. This card only shows once.</p>
      </div>
    </div>
  );
});
