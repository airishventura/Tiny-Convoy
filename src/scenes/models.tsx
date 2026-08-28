/**
 * Hand-built convoy models.
 *
 * Every vehicle is assembled from shared boxes, cylinders and cones — no
 * imported assets, nothing to download, and one material per colour so the
 * whole convoy draws in a handful of calls. Damage is expressed in the model
 * itself: rust creeps into the paint, panels go missing, a headlight dies.
 */

import { memo, useMemo } from 'react';
import * as THREE from 'three';
import { damageState, MODULES, type ModuleInstance } from '@/game/vehicle/modules';
import { clamp01, lerp } from '@/lib/math';
import { chromeMaterial, glassMaterial, lampMaterial, paintedMaterial, tyreMaterial, wheelGeo } from './materials';

const RUST = new THREE.Color('#6d4630');
const scratchColor = new THREE.Color();

/** Paint fades and rusts as a module takes damage. */
export const weatheredPaint = (paint: string, condition: number): string => {
  scratchColor.set(paint);
  scratchColor.lerp(RUST, (1 - clamp01(condition)) * 0.65);
  scratchColor.multiplyScalar(lerp(0.78, 1, clamp01(condition)));
  return `#${scratchColor.getHexString()}`;
};

export const trimOf = (paint: string): string => {
  scratchColor.set(paint);
  scratchColor.multiplyScalar(0.62);
  return `#${scratchColor.getHexString()}`;
};

interface BoxProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  size: [number, number, number];
  material: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

const Box = ({ position, rotation, size, material, castShadow = true, receiveShadow = true }: BoxProps) => (
  <mesh position={position} rotation={rotation} material={material} castShadow={castShadow} receiveShadow={receiveShadow}>
    <boxGeometry args={size} />
  </mesh>
);

const Cyl = ({
  position,
  rotation,
  radius,
  length,
  material,
  segments = 10,
}: {
  position?: [number, number, number];
  rotation?: [number, number, number];
  radius: number;
  length: number;
  material: THREE.Material;
  segments?: number;
}) => (
  <mesh position={position} rotation={rotation} material={material} castShadow receiveShadow>
    <cylinderGeometry args={[radius, radius, length, segments]} />
  </mesh>
);

// ── Wheels ──────────────────────────────────────────────────────────────────

export const Wheel = memo(function Wheel({ radius }: { radius: number }) {
  const hub = chromeMaterial();
  return (
    <group>
      <mesh geometry={wheelGeo()} material={tyreMaterial()} scale={[radius * 0.62, radius, radius]} castShadow />
      <mesh geometry={wheelGeo()} material={hub} scale={[radius * 0.66, radius * 0.55, radius * 0.55]} />
    </group>
  );
});

// ── Command truck ───────────────────────────────────────────────────────────

export const TruckModel = memo(function TruckModel({ module, headlights }: { module: ModuleInstance; headlights: boolean }) {
  const spec = MODULES.command;
  const state = damageState(module.condition);
  const paint = paintedMaterial(weatheredPaint(module.paint, module.condition));
  const trim = paintedMaterial(trimOf(weatheredPaint(module.paint, module.condition)));
  const dark = paintedMaterial('#33302c');
  const chrome = chromeMaterial();
  const glass = glassMaterial();
  const lamp = lampMaterial(headlights ? '#ffe6b0' : '#5b5348', headlights ? 2.4 : 0.05);
  const canvas = paintedMaterial('#cbbb96');

  const brokenLight = state === 'critical';

  return (
    <group name="truck-model">
      {/* Chassis rails */}
      <Box size={[1.95, 0.3, 5.0]} position={[0, -0.6, 0]} material={dark} />

      {/* Bonnet and cab */}
      <Box size={[1.92, 0.6, 1.55]} position={[0, -0.06, 1.5]} material={paint} />
      <Box size={[1.78, 0.16, 1.35]} position={[0, 0.28, 1.5]} material={trim} />
      <Box size={[2.08, 1.02, 1.65]} position={[0, 0.36, 0.15]} material={paint} />
      <Box size={[2.14, 0.12, 0.5]} position={[0, 0.9, 0.85]} material={trim} />

      {/* Glass */}
      <mesh position={[0, 0.45, 0.98]} rotation={[-0.2, 0, 0]} material={glass} castShadow={false}>
        <boxGeometry args={[1.76, 0.66, 0.07]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 1.02, 0.42, 0.24]} material={glass} castShadow={false}>
          <boxGeometry args={[0.07, 0.5, 0.92]} />
        </mesh>
      ))}

      {/* Grille, bar and lights */}
      <Box size={[1.66, 0.44, 0.1]} position={[0, -0.04, 2.28]} material={chrome} />
      <Box size={[1.95, 0.16, 0.16]} position={[0, -0.42, 2.36]} material={chrome} />
      {[-0.55, 0, 0.55].map((x) => (
        <Box key={x} size={[0.12, 0.62, 0.12]} position={[x, -0.14, 2.36]} material={chrome} />
      ))}
      {[-0.68, 0.68].map((x, i) => (
        <Box
          key={x}
          size={[0.32, 0.24, 0.1]}
          position={[x, 0.06, 2.3]}
          material={brokenLight && i === 0 ? dark : lamp}
          castShadow={false}
        />
      ))}
      {/* Roof lamps — pure charm, and they read at sunset. */}
      {[-0.6, -0.2, 0.2, 0.6].map((x) => (
        <Box key={x} size={[0.22, 0.14, 0.16]} position={[x, 0.98, 0.9]} material={lamp} castShadow={false} />
      ))}

      {/* Mirrors */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <Cyl position={[s * 1.16, 0.62, 0.92]} radius={0.03} length={0.5} material={chrome} segments={6} />
          <Box size={[0.08, 0.42, 0.2]} position={[s * 1.26, 0.72, 0.92]} material={dark} />
        </group>
      ))}

      {/* Stack, side tanks, steps */}
      <Cyl position={[-1.05, 0.5, 0.85]} radius={0.08} length={1.7} material={chrome} segments={8} />
      {[-1, 1].map((s) => (
        <Cyl key={s} position={[s * 1.06, -0.5, 0.1]} rotation={[Math.PI / 2, 0, 0]} radius={0.27} length={1.3} material={chrome} segments={10} />
      ))}
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.34, 0.06, 0.5]} position={[s * 1.12, -0.82, 0.7]} material={dark} />
      ))}

      {/* Rear deck, toolbox, spare */}
      <Box size={[2.0, 0.16, 1.9]} position={[0, -0.38, -1.35]} material={trim} />
      <Box size={[1.3, 0.5, 0.62]} position={[0, -0.05, -0.85]} material={canvas} />
      <mesh position={[0, -0.02, -1.85]} rotation={[0, 0, Math.PI / 2]} material={tyreMaterial()} castShadow>
        <cylinderGeometry args={[0.44, 0.44, 0.24, 12]} />
      </mesh>

      {/* Mudguards */}
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.5, 0.1, 1.5]} position={[s * 1.02, -0.28, -1.2]} material={dark} />
      ))}

      {/* Hitch */}
      <Box size={[0.34, 0.16, 0.6]} position={[0, -0.62, -2.55]} material={chrome} />
      <mesh position={[0, -0.5, -2.7]} material={chrome}>
        <sphereGeometry args={[0.13, 8, 6]} />
      </mesh>

      {/* Damage: a panel hanging off, then a missing one. */}
      {(state === 'battered' || state === 'critical') && (
        <Box size={[0.06, 0.5, 1.0]} position={[1.08, -0.1, -0.2]} rotation={[0.2, 0, 0.5]} material={trim} />
      )}
      {state === 'critical' && <Box size={[0.5, 0.06, 1.2]} position={[-0.6, 0.28, 1.5]} rotation={[0.1, 0.2, 0.35]} material={dark} />}

      <ModuleDecal module={module} width={spec.size[0] * 1.5} y={0.3} z={0.1} />
    </group>
  );
});

const ModuleDecal = ({ module, width, y, z }: { module: ModuleInstance; width: number; y: number; z: number }) => {
  const stripe = paintedMaterial(trimOf(module.paint));
  return (
    <>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (width / 2 + 0.02), y, z]} rotation={[0, s * Math.PI * 0.5, 0]} material={stripe} castShadow={false}>
          <boxGeometry args={[1.2, 0.14, 0.02]} />
        </mesh>
      ))}
    </>
  );
};

// ── Trailers ────────────────────────────────────────────────────────────────

const Drawbar = ({ z }: { z: number }) => {
  const chrome = chromeMaterial();
  return (
    <group>
      <Box size={[0.18, 0.14, 1.0]} position={[0, -0.55, z]} material={chrome} />
      <mesh position={[0, -0.5, z + 0.5]} rotation={[Math.PI / 2, 0, 0]} material={chrome}>
        <torusGeometry args={[0.13, 0.045, 6, 10]} />
      </mesh>
    </group>
  );
};

const CargoBody = ({ module }: { module: ModuleInstance }) => {
  const paint = paintedMaterial(weatheredPaint(module.paint, module.condition));
  const trim = paintedMaterial(trimOf(weatheredPaint(module.paint, module.condition)));
  const canvas = paintedMaterial(weatheredPaint('#d3c39c', module.condition));
  const dark = paintedMaterial('#33302c');
  const state = damageState(module.condition);

  return (
    <group>
      <Box size={[2.2, 0.22, 4.4]} position={[0, -0.52, 0]} material={trim} />
      {[-1, 1].map((s) => (
        <group key={s}>
          {[-1.7, -0.85, 0, 0.85, 1.7].map((z, i) =>
            state === 'critical' && i === 1 && s === 1 ? null : (
              <Box key={z} size={[0.1, 0.75, 0.1]} position={[s * 1.06, -0.05, z]} material={trim} />
            ),
          )}
          <Box size={[0.08, 0.1, 4.2]} position={[s * 1.06, 0.24, 0]} material={trim} />
        </group>
      ))}
      {/* Canvas tilt */}
      {state !== 'critical' && <Box size={[2.06, 0.86, 3.7]} position={[0, 0.55, -0.1]} material={canvas} />}
      {state !== 'critical' && <Box size={[2.12, 0.1, 3.76]} position={[0, 0.98, -0.1]} material={trim} />}
      {/* Crates you can actually see when the tilt is gone */}
      <Box size={[0.9, 0.62, 1.1]} position={[-0.5, -0.1, 1.1]} material={paint} />
      <Box size={[0.8, 0.5, 0.9]} position={[0.55, -0.16, -0.4]} material={dark} />
      <Drawbar z={2.05} />
    </group>
  );
};

const TankerBody = ({ module }: { module: ModuleInstance }) => {
  const paint = paintedMaterial(weatheredPaint(module.paint, module.condition));
  const trim = paintedMaterial(trimOf(weatheredPaint(module.paint, module.condition)));
  const chrome = chromeMaterial();
  const state = damageState(module.condition);

  return (
    <group>
      <Box size={[2.0, 0.2, 4.4]} position={[0, -0.62, 0]} material={trim} />
      <mesh position={[0, 0.08, 0]} rotation={[Math.PI / 2, 0, 0]} material={paint} castShadow receiveShadow>
        <cylinderGeometry args={[0.8, 0.8, 4.1, 14]} />
      </mesh>
      {[-2.05, 2.05].map((z) => (
        <mesh key={z} position={[0, 0.08, z]} material={trim} castShadow>
          <sphereGeometry args={[0.8, 12, 8]} />
        </mesh>
      ))}
      {/* Straps */}
      {[-1.2, 0, 1.2].map((z) => (
        <mesh key={z} position={[0, 0.08, z]} rotation={[Math.PI / 2, 0, 0]} material={trim} castShadow={false}>
          <torusGeometry args={[0.82, 0.05, 6, 14]} />
        </mesh>
      ))}
      {/* Catwalk and railing */}
      <Box size={[0.7, 0.06, 3.2]} position={[0, 0.9, 0]} material={chrome} />
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.05, 0.32, 3.0]} position={[s * 0.34, 1.06, 0]} material={chrome} />
      ))}
      <Box size={[0.5, 0.5, 0.4]} position={[0, -0.2, -2.1]} material={chrome} />
      {state === 'critical' && <Box size={[0.3, 0.06, 0.6]} position={[0.85, -0.35, 0.6]} rotation={[0, 0, 0.6]} material={trim} />}
      <Drawbar z={2.15} />
    </group>
  );
};

const RepairBody = ({ module }: { module: ModuleInstance }) => {
  const paint = paintedMaterial(weatheredPaint(module.paint, module.condition));
  const trim = paintedMaterial(trimOf(weatheredPaint(module.paint, module.condition)));
  const chrome = chromeMaterial();
  const lamp = lampMaterial('#ffd9a0', 1.4);
  const state = damageState(module.condition);

  return (
    <group>
      <Box size={[2.2, 1.75, 4.2]} position={[0, 0.05, 0]} material={paint} />
      <Box size={[2.26, 0.14, 4.26]} position={[0, 0.95, 0]} material={trim} />
      {/* Roller door */}
      {[-0.5, -0.18, 0.14, 0.46].map((y) => (
        <Box key={y} size={[1.7, 0.24, 0.06]} position={[0, y, -2.12]} material={trim} />
      ))}
      {/* Side toolboxes */}
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.22, 0.5, 1.6]} position={[s * 1.16, -0.42, 0.4]} material={trim} />
      ))}
      {/* Crane */}
      <Cyl position={[0.6, 1.35, -1.2]} radius={0.09} length={0.8} material={chrome} segments={8} />
      <Box size={[0.16, 0.16, 2.0]} position={[0.6, 1.7, -0.4]} rotation={[0.22, 0, 0]} material={chrome} />
      <Box size={[0.3, 0.2, 0.3]} position={[0, 1.02, 1.9]} material={state === 'critical' ? trim : lamp} castShadow={false} />
      <Drawbar z={1.95} />
    </group>
  );
};

const CabinBody = ({ module }: { module: ModuleInstance }) => {
  const paint = paintedMaterial(weatheredPaint(module.paint, module.condition));
  const trim = paintedMaterial(trimOf(weatheredPaint(module.paint, module.condition)));
  const glass = glassMaterial();
  const chrome = chromeMaterial();
  const warm = lampMaterial('#ffcf8a', 2.2);
  const canvas = paintedMaterial('#d8c9a4');
  const state = damageState(module.condition);

  return (
    <group>
      <Box size={[2.25, 2.1, 4.5]} position={[0, 0.05, 0]} material={paint} />
      {/* Pitched roof */}
      <mesh position={[0, 1.28, 0]} rotation={[0, Math.PI / 4, 0]} material={trim} castShadow receiveShadow>
        <cylinderGeometry args={[0, 1.72, 0.55, 4]} />
      </mesh>
      {/* Windows */}
      {[-1, 1].map((s) =>
        [-1.1, 0.4].map((z) => (
          <mesh key={`${s}-${z}`} position={[s * 1.14, 0.35, z]} material={glass} castShadow={false}>
            <boxGeometry args={[0.08, 0.6, 0.8]} />
          </mesh>
        )),
      )}
      <mesh position={[0, 0.35, 2.27]} material={glass} castShadow={false}>
        <boxGeometry args={[1.1, 0.6, 0.08]} />
      </mesh>
      {/* Chimney and awning */}
      <Cyl position={[0.7, 1.75, -1.3]} radius={0.12} length={0.7} material={chrome} segments={8} />
      {state !== 'critical' && (
        <Box size={[1.1, 0.06, 2.6]} position={[1.72, 0.95, 0.1]} rotation={[0, 0, -0.14]} material={canvas} />
      )}
      {/* String lights */}
      {[-1.6, -0.8, 0, 0.8, 1.6].map((z) => (
        <mesh key={z} position={[1.2, 0.98, z]} material={warm} castShadow={false}>
          <sphereGeometry args={[0.08, 6, 5]} />
        </mesh>
      ))}
      {/* Ladder */}
      {[0.28, 0.62, 0.96].map((y) => (
        <Box key={y} size={[0.5, 0.06, 0.06]} position={[0, y, -2.3]} material={chrome} />
      ))}
      <Drawbar z={2.1} />
    </group>
  );
};

export const TrailerModel = memo(function TrailerModel({ module }: { module: ModuleInstance }) {
  switch (module.kind) {
    case 'fuel':
      return <TankerBody module={module} />;
    case 'repair':
      return <RepairBody module={module} />;
    case 'living':
      return <CabinBody module={module} />;
    default:
      return <CargoBody module={module} />;
  }
});

export const ModuleModel = memo(function ModuleModel({
  module,
  headlights = false,
}: {
  module: ModuleInstance;
  headlights?: boolean;
}) {
  return module.kind === 'command' ? <TruckModel module={module} headlights={headlights} /> : <TrailerModel module={module} />;
});

/** Bounding size used by the garage camera framing. */
export const useModuleBounds = (modules: ModuleInstance[]): { length: number; height: number } =>
  useMemo(() => {
    let length = 0;
    let height = 0;
    for (const m of modules) {
      const s = MODULES[m.kind].size;
      length += s[2] * 2 + 0.55;
      height = Math.max(height, s[1] * 2);
    }
    return { length, height };
  }, [modules]);
