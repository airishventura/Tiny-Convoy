/**
 * Pause menu.
 *
 * Physics stops, audio ducks, and the road stays visible behind — you are
 * still out there, you have just stopped for a moment.
 */

import { memo, useId, useRef } from 'react';
import { run } from '@/game/runtime';
import { useHud } from '@/state/useHud';
import { useUI } from '@/state/useUI';
import { Button, Divider, Key, Label, Panel, useFocusTrap } from '@/ui/components';
import { formatDistance, formatTime } from '@/lib/math';

const CONTROLS: Array<[string, string]> = [
  ['WASD / Arrows', 'Drive'],
  ['Space', 'Brake'],
  ['Shift', 'Boost'],
  ['E', 'Interact — hold to work'],
  ['R', 'Quick repair — hold, same as E'],
  ['C', 'Change camera'],
  ['Tab (hold)', 'Convoy overview'],
  ['M', 'Toggle map'],
  ['H', 'Horn'],
  ['X', 'Handbrake'],
  ['Esc', 'Pause'],
];

export const PauseMenu = memo(function PauseMenu() {
  const setPaused = useUI((s) => s.setPaused);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const quitToTitle = useUI((s) => s.quitToTitle);
  const hud = useHud((s) => s.hud);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // PauseMenu is only ever rendered while it applies, so the trap is active
  // for the component's whole lifetime — no boolean to thread in from a prop.
  useFocusTrap(true, panelRef);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-ink/55 backdrop-blur-[3px] fade-in">
      <Panel className="w-full max-w-2xl overflow-hidden rise-in">
        <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="outline-none">
          <div className="flex items-baseline justify-between border-b border-line px-6 py-4">
            <h2 id={titleId} className="text-xl">Stopped on the shoulder</h2>
            <span className="text-xs tabular text-muted">
              {formatTime(hud.elapsed)} · {formatDistance(hud.distanceRemaining)} to go
            </span>
          </div>

          <div className="grid gap-6 px-6 py-5 md:grid-cols-[1fr_auto]">
            <div>
              <Label>Controls</Label>
              <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {CONTROLS.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 text-xs text-sand">
                    <Key>{k}</Key>
                    <span className="text-right text-muted">{v}</span>
                  </div>
                ))}
              </div>
              <Divider className="my-4" />
              <p className="text-xs leading-relaxed text-muted">
                A gamepad works too: right trigger to drive, left stick to steer, A to brake, right bumper to boost.
              </p>
            </div>

            <div className="flex min-w-52 flex-col gap-2">
              <Button variant="primary" full onClick={() => setPaused(false)}>
                Back to the road
              </Button>
              <Button full onClick={() => setSettingsOpen(true)}>
                Settings
              </Button>
              <Button
                full
                variant="danger"
                onClick={() => {
                  run.fail('You called it off and turned back');
                  setPaused(false);
                }}
              >
                Abandon expedition
              </Button>
              <Button
                full
                variant="ghost"
                onClick={() => {
                  run.reset();
                  quitToTitle();
                }}
              >
                Quit to title
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
});
