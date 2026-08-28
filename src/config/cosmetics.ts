/**
 * Cosmetics.
 *
 * Paint only ever changes how the convoy looks. Holder-gated paints are marked
 * `holder: true` — they unlock with a verified token balance and confer no
 * handling, score or economy advantage whatsoever.
 */

export interface Paint {
  id: string;
  name: string;
  color: string;
  /** Secondary colour used for panels and trim. */
  trim: string;
  /** Scrap price. 0 = owned from the start. */
  price: number;
  /** Requires a verified $CONVOY balance. Cosmetic only. */
  holder?: boolean;
  blurb: string;
}

export const PAINTS: Paint[] = [
  { id: 'rust', name: 'Honest Rust', color: '#b25c31', trim: '#7a3f24', price: 0, blurb: 'The colour it arrived in.' },
  { id: 'sand', name: 'Bleached Sand', color: '#c8a878', trim: '#8f7550', price: 0, blurb: 'Hides the dust. Shows the dents.' },
  { id: 'sage', name: 'Depot Sage', color: '#6d8069', trim: '#485546', price: 120, blurb: 'Old highway-authority green.' },
  { id: 'ochre', name: 'Ochre Line', color: '#d08a3a', trim: '#8c5a24', price: 180, blurb: 'Warm as the last hour of light.' },
  { id: 'slate', name: 'Cold Slate', color: '#5c6470', trim: '#3b414a', price: 240, blurb: 'For crews who prefer not to be seen.' },
  { id: 'cream', name: 'Creamery', color: '#e6dcc2', trim: '#b0a082', price: 300, blurb: 'Bright, impractical, beloved.' },
  { id: 'plum', name: 'Dust Plum', color: '#7a4f5e', trim: '#4e323c', price: 420, blurb: 'Sunset on the canyon wall.' },
  {
    id: 'league',
    name: 'League Livery',
    color: '#2f4f4a',
    trim: '#d8a24a',
    price: 0,
    holder: true,
    blurb: 'Convoy League racing paint. Verified holders only — looks fast, is not.',
  },
  {
    id: 'ember',
    name: 'Ember Coach',
    color: '#8c3b22',
    trim: '#e8b86a',
    price: 0,
    holder: true,
    blurb: 'Hand-lacquered coachwork with brass trim.',
  },
  {
    id: 'nightrun',
    name: 'Night Run',
    color: '#232a35',
    trim: '#c9a227',
    price: 0,
    holder: true,
    blurb: 'Deep blue-black with a single gold stripe.',
  },
];

export const paintById = (id: string): Paint => PAINTS.find((p) => p.id === id) ?? PAINTS[0];
export const holderPaints = (): Paint[] => PAINTS.filter((p) => p.holder);
export const freePaints = (): Paint[] => PAINTS.filter((p) => !p.holder);
export const DEFAULT_OWNED = ['rust', 'sand'];
