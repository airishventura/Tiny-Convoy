/**
 * A parked convoy.
 *
 * Same models and same wheel geometry as the driven rig, but posed at rest with
 * no physics at all. Used by the title screen and the garage, which is what
 * keeps those screens loading in a fraction of a second.
 */

import { memo, useMemo } from 'react';
import { layoutConvoy, trailerConfig, truckConfig } from '@/game/vehicle/vehicleConfig';
import { totalConvoyMass } from '@/game/vehicle/vehicleConfig';
import type { Convoy } from '@/game/vehicle/modules';
import { ModuleModel, Wheel } from './models';

export interface StaticConvoyProps {
  convoy: Convoy;
  /** Ground height under the convoy. */
  groundY?: number;
  headlights?: boolean;
  /** Index to highlight by lifting it slightly. -1 for none. */
  highlight?: number;
}

export const StaticConvoy = memo(function StaticConvoy({ convoy, groundY = 0, headlights = false, highlight = -1 }: StaticConvoyProps) {
  const layout = useMemo(() => layoutConvoy(convoy), [convoy]);
  const mass = useMemo(() => totalConvoyMass(convoy), [convoy]);

  const units = useMemo(
    () =>
      convoy.map((m, i) => {
        const cfg = i === 0 ? truckConfig(m, mass) : trailerConfig(m);
        const restLength = cfg.suspensionRest + 0.65 * cfg.suspensionTravel;
        const w = cfg.wheels[0];
        return { module: m, cfg, restLength, restHeight: restLength + w.radius - w.y };
      }),
    [convoy, mass],
  );

  return (
    <group name="static-convoy">
      {units.map((u, i) => (
        <group key={u.module.id} position={[0, groundY + u.restHeight + (highlight === i ? 0.18 : 0), -layout[i].offset]}>
          <ModuleModel module={u.module} headlights={headlights} />
          {u.cfg.wheels.map((w, k) => (
            <group key={k} position={[w.x, w.y - u.restLength, w.z]}>
              <Wheel radius={w.radius} />
            </group>
          ))}
        </group>
      ))}
    </group>
  );
});

/** Nose-to-tail length, for framing a camera around the convoy. */
export const convoyLength = (convoy: Convoy): number => {
  const layout = layoutConvoy(convoy);
  const last = layout[layout.length - 1];
  return last.offset + last.halfExtents[2];
};
