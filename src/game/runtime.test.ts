/**
 * Run controller: the interaction hold timer.
 *
 * `updateInteraction` is device-agnostic — it only ever sees a boolean — so
 * this pins down the accumulate/decay/complete contract that both keyboard
 * and gamepad hold-to-work rely on.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { run, type InteractionTarget } from './runtime';
import { DELIVERY } from './systems/missions';
import { makeModule } from './vehicle/modules';
import { SETTLEMENT } from './world/pois';
import { highway } from './world/route';

const target = (over: Partial<InteractionTarget> = {}): InteractionTarget => ({
  kind: 'poi',
  id: '__test__',
  title: 'Test target',
  hint: 'Hold to test',
  duration: 1,
  ...over,
});

beforeEach(() => {
  run.reset();
  run.interaction = null;
  run.interactHold = 0;
});

/** A truck plus one trailer, so there is a coupling that can part. */
const startRun = (): void => run.start(DELIVERY, [makeModule('command'), makeModule('cargo')], null);

/** Well clear of every point of interest, so proximity tests stay isolated. */
const nowhere = highway.at(2400, 260);

describe('RunController.updateInteraction', () => {
  it('stays at zero with no active interaction, regardless of held', () => {
    run.updateInteraction(0.5, true);
    expect(run.interactHold).toBe(0);

    run.updateInteraction(0.5, false);
    expect(run.interactHold).toBe(0);
  });

  it('accumulates by dt while held, and completes at duration', () => {
    run.interaction = target({ duration: 1 });

    run.updateInteraction(0.4, true);
    expect(run.interactHold).toBeCloseTo(0.4);
    expect(run.interaction).not.toBeNull();

    run.updateInteraction(0.4, true);
    expect(run.interactHold).toBeCloseTo(0.8);
    expect(run.interaction).not.toBeNull();

    run.updateInteraction(0.4, true);
    expect(run.interaction).toBeNull();
    expect(run.interactHold).toBe(0);
  });

  it('decays toward zero, clamped, while not held', () => {
    run.interaction = target({ duration: 10 });
    run.updateInteraction(1, true);
    expect(run.interactHold).toBeCloseTo(1);

    run.updateInteraction(0.5, false);
    expect(run.interactHold).toBeCloseTo(1 - 0.5 * 1.6);

    run.updateInteraction(1, false);
    expect(run.interactHold).toBe(0);
  });
});

describe('RunController.updateProximity', () => {
  it('offers the re-hitch prompt once the trailer is close and lined up', () => {
    startRun();
    // Must be a real emergency: the tick recomputes detachedIndex from effects.
    run.trigger('hitch_failure', 0.8);
    run.reportRehitch(1, 0.9);

    run.tick(1 / 60, nowhere.x, nowhere.z, 0, 0, false);

    expect(run.interaction?.kind).toBe('rehitch');
  });

  it('lets a stopped convoy finish even with a repair outstanding', () => {
    startRun();
    run.trigger('fuel_leak', 0.8);

    run.tick(1 / 60, SETTLEMENT.x, SETTLEMENT.z, 0, 0, false);

    expect(run.phase).toBe('finished');
  });
});
