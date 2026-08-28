/**
 * First-drive control hint — the policy, kept separate from the component so
 * the one rule that matters ("it appears once and never nags") is testable.
 */

/** Seconds of actual driving after which the hint retires by itself. */
export const HINT_SECONDS = 22;

export interface HintContext {
  /** The `showHints` setting. */
  showHints: boolean;
  /** True once the player has seen the hint through, on this machine. */
  tutorialDone: boolean;
  /** True once dismissed by hand during this run. */
  dismissed: boolean;
  /** Seconds elapsed in the current run. */
  elapsed: number;
}

export const controlHintVisible = ({ showHints, tutorialDone, dismissed, elapsed }: HintContext): boolean =>
  showHints && !tutorialDone && !dismissed && elapsed < HINT_SECONDS;

/**
 * True at the moment the hint has run its course, so the caller can record
 * that the player has seen it. Separate from `controlHintVisible` because a
 * hint hidden by the setting must not count as seen.
 */
export const controlHintFinished = ({ showHints, tutorialDone, dismissed, elapsed }: HintContext): boolean =>
  showHints && !tutorialDone && (dismissed || elapsed >= HINT_SECONDS);

/** The six things a first-time driver needs, in the order they need them. */
export const HINT_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', 'Drive and steer'],
  ['Space', 'Brake'],
  ['Shift', 'Boost'],
  ['E (hold)', 'Work at a stop — repair, hitch, collect'],
  ['Tab (hold)', 'Convoy overview'],
  ['Esc', 'Pause and full controls'],
];
