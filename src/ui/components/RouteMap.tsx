/**
 * Route map.
 *
 * Drawn straight from the same spline data the world is built from, so the map
 * cannot drift out of sync with the road. Optionally shows live progress.
 */

import { memo, useMemo } from 'react';
import { POIS } from '@/game/world/pois';
import { canyonDetour, highway, shortcut, type RoadPath } from '@/game/world/route';

const PADDING = 14;

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const computeBounds = (paths: RoadPath[]): Bounds => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of paths) {
    for (let i = 0; i < p.px.length; i++) {
      minX = Math.min(minX, p.px[i]);
      maxX = Math.max(maxX, p.px[i]);
      minZ = Math.min(minZ, p.pz[i]);
      maxZ = Math.max(maxZ, p.pz[i]);
    }
  }
  return { minX, maxX, minZ, maxZ };
};

const POI_TONE: Record<string, string> = {
  garage: '#eaa463',
  settlement: '#d97a34',
  scrapyard: '#9a8a75',
  fuel_station: '#9a8a75',
  salvage: '#7d9a80',
  viewpoint: '#7d9a80',
  canyon: '#b2512b',
  bridge: '#d9553f',
  junction: '#6f6355',
};

export interface RouteMapProps {
  /** 0..1 — draws a marker along the highway. */
  progress?: number;
  className?: string;
  showLabels?: boolean;
  height?: number;
}

export const RouteMap = memo(function RouteMap({ progress, className = '', height = 190 }: RouteMapProps) {
  const paths = useMemo(() => [highway, shortcut, canyonDetour], []);
  const bounds = useMemo(() => computeBounds(paths), [paths]);

  const width = 560;
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const scale = Math.min((width - PADDING * 2) / spanX, (height - PADDING * 2) / spanZ);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanZ * scale) / 2;

  const project = (x: number, z: number): [number, number] => [
    offsetX + (x - bounds.minX) * scale,
    offsetY + (z - bounds.minZ) * scale,
  ];

  const toPath = (p: RoadPath, stride: number): string => {
    let d = '';
    for (let i = 0; i < p.px.length; i += stride) {
      const [x, y] = project(p.px[i], p.pz[i]);
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d;
  };

  const marker = useMemo(() => {
    if (progress === undefined) return null;
    const s = progress * highway.length;
    const p = highway.at(s);
    return project(p.x, p.z);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, scale, offsetX, offsetY]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`w-full ${className}`}
      role="img"
      aria-label="Map of the Ochre Run"
      style={{ height }}
    >
      <defs>
        <linearGradient id="routeFade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#cdbb9c" />
          <stop offset="100%" stopColor="#d97a34" />
        </linearGradient>
      </defs>

      <path d={toPath(shortcut, 3)} fill="none" stroke="#6f6355" strokeWidth={2} strokeDasharray="5 5" strokeLinecap="round" />
      <path d={toPath(canyonDetour, 3)} fill="none" stroke="#8a5a3c" strokeWidth={2} strokeDasharray="3 6" strokeLinecap="round" />
      <path d={toPath(highway, 3)} fill="none" stroke="url(#routeFade)" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />

      {POIS.map((poi) => {
        const [x, y] = project(poi.x, poi.z);
        const tone = POI_TONE[poi.kind] ?? '#9a8a75';
        const big = poi.kind === 'garage' || poi.kind === 'settlement';
        return (
          <g key={poi.id}>
            <circle cx={x} cy={y} r={big ? 5 : 3} fill={tone} opacity={big ? 1 : 0.85} />
            {big && <circle cx={x} cy={y} r={8.5} fill="none" stroke={tone} strokeWidth={1} opacity={0.5} />}
          </g>
        );
      })}

      {marker && (
        <g>
          <circle cx={marker[0]} cy={marker[1]} r={6} fill="#f4ead9" />
          <circle cx={marker[0]} cy={marker[1]} r={10} fill="none" stroke="#f4ead9" strokeWidth={1.2} opacity={0.5} />
        </g>
      )}
    </svg>
  );
});
