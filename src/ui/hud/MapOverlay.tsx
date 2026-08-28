/**
 * Map overlay.
 *
 * Toggled by M — not a seventh permanent HUD readout. It borrows the same
 * route data the briefing already draws from, with a live position marker fed
 * by the throttled HUD snapshot, so keeping it in sync costs nothing extra and
 * never touches the physics frame loop. Pointer-events stay off throughout:
 * this is a glance, not a menu, and driving never stops for it.
 */

import { memo, useEffect, useState } from 'react';
import { input } from '@/game/input/inputManager';
import { useHud } from '@/state/useHud';
import { RouteMap } from '@/ui/components/RouteMap';

export const MapOverlay = memo(function MapOverlay() {
  const [visible, setVisible] = useState(false);
  const progress = useHud((s) => s.hud.progress);

  useEffect(
    () =>
      input.on((action) => {
        if (action === 'map') setVisible((v) => !v);
      }),
    [],
  );

  if (!visible) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center fade-in">
      <div className="hud-chip w-[min(30rem,86vw)] px-5 py-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="label">The Ochre Run</span>
          <span className="text-[0.7rem] text-muted">M to close</span>
        </div>
        <RouteMap progress={progress} height={210} />
      </div>
    </div>
  );
});
