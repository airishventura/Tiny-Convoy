/**
 * Input.
 *
 * Keyboard and gamepad are merged into one analogue state that the vehicle sim
 * reads each physics step. Discrete actions (interact, camera, pause) are
 * edge-detected and drained by whoever cares, so no React state is involved in
 * the driving path at all.
 */

import { clamp, deadzone } from '@/lib/math';

export type Action = 'interact' | 'camera' | 'overview' | 'pause' | 'horn' | 'repair' | 'map';

export interface InputState {
  /** -1 reverse … 1 forward */
  throttle: number;
  /** -1 left … 1 right */
  steer: number;
  /** 0..1 footbrake */
  brake: number;
  /** 0..1 boost request */
  boost: number;
  /** 0..1 handbrake */
  handbrake: number;
  /** True while the overview key is held. */
  overviewHeld: boolean;
  /** True while the interact key/button is held. */
  interactHeld: boolean;
  gamepad: boolean;
}

const KEY_MAP: Record<string, keyof typeof held | undefined> = {
  KeyW: 'fwd',
  ArrowUp: 'fwd',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'brake',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
  KeyX: 'handbrake',
};

const held = {
  fwd: false,
  back: false,
  left: false,
  right: false,
  brake: false,
  boost: false,
  handbrake: false,
  overview: false,
  interact: false,
  /** R, held. Merged into `interactHeld` below rather than given its own field
   *  on `InputState` — the only consumer of a hold is the run's existing
   *  hold-to-work system, and the overwhelming reason to hold something down
   *  mid-route is a repair, so R rides the same signal E already drives
   *  through `ConvoyRig` → `run.updateInteraction` instead of a parallel path. */
  repair: false,
};

const ACTION_KEYS: Record<string, Action> = {
  KeyE: 'interact',
  KeyC: 'camera',
  Tab: 'overview',
  Escape: 'pause',
  KeyH: 'horn',
  KeyR: 'repair',
  KeyM: 'map',
};

type Listener = (action: Action) => void;

class InputManager {
  readonly state: InputState = {
    throttle: 0,
    steer: 0,
    brake: 0,
    boost: 0,
    handbrake: 0,
    overviewHeld: false,
    interactHeld: false,
    gamepad: false,
  };

  private listeners = new Set<Listener>();
  private enabled = true;
  private attached = false;
  private steerSmooth = 0;
  private padIndex: number | null = null;

  attach(): () => void {
    if (this.attached) return () => undefined;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onPadConnected);
    window.addEventListener('gamepaddisconnected', this.onPadDisconnected);
    return () => {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
      window.removeEventListener('gamepadconnected', this.onPadConnected);
      window.removeEventListener('gamepaddisconnected', this.onPadDisconnected);
      this.attached = false;
    };
  }

  /** Driving input is suppressed while menus are open; actions still fire. */
  setDrivingEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.resetHeld();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(action: Action): void {
    for (const l of this.listeners) l(action);
  }

  private resetHeld(): void {
    for (const k of Object.keys(held) as Array<keyof typeof held>) held[k] = false;
  }

  private onBlur = (): void => this.resetHeld();

  private onPadConnected = (e: Event): void => {
    this.padIndex = (e as GamepadEvent).gamepad.index;
    this.state.gamepad = true;
  };

  private onPadDisconnected = (): void => {
    this.padIndex = null;
    this.state.gamepad = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    const action = ACTION_KEYS[e.code];
    if (action) {
      e.preventDefault();
      if (!e.repeat) this.emit(action);
      if (action === 'overview') held.overview = true;
      if (action === 'interact') held.interact = true;
      if (action === 'repair') held.repair = true;
    }
    const key = KEY_MAP[e.code];
    if (key) {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      held[key] = true;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (key) held[key] = false;
    if (e.code === 'Tab') held.overview = false;
    if (e.code === 'KeyE') held.interact = false;
    if (e.code === 'KeyR') held.repair = false;
  };

  private pollGamepad(): {
    throttle: number;
    steer: number;
    brake: number;
    boost: number;
    handbrake: boolean;
    interact: boolean;
    active: boolean;
  } | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    const pad = this.padIndex !== null ? pads[this.padIndex] : pads.find((p) => p && p.connected);
    if (!pad) return null;

    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const stick = deadzone(pad.axes[0] ?? 0, 0.14);
    const aBtn = pad.buttons[0]?.pressed ?? false;
    const bBtn = pad.buttons[1]?.pressed ?? false;
    const boost = pad.buttons[5]?.value ?? (pad.buttons[2]?.pressed ? 1 : 0);

    // Face buttons double as actions so a pad alone can play.
    const interactBtn = pad.buttons[3]?.pressed ?? false;
    if (interactBtn && !this.padPrev.y) this.emit('interact');
    if (pad.buttons[9]?.pressed && !this.padPrev.start) this.emit('pause');
    if (pad.buttons[8]?.pressed && !this.padPrev.select) this.emit('camera');
    held.overview = pad.buttons[4]?.pressed ?? false;
    this.padPrev.y = interactBtn;
    this.padPrev.start = pad.buttons[9]?.pressed ?? false;
    this.padPrev.select = pad.buttons[8]?.pressed ?? false;

    const throttle = rt - lt * 0.9;
    const active = Math.abs(stick) > 0.02 || rt > 0.02 || lt > 0.02 || aBtn || bBtn;
    return { throttle, steer: stick, brake: aBtn ? 1 : 0, boost, handbrake: bBtn, interact: interactBtn, active };
  }

  private padPrev = { y: false, start: false, select: false };

  /** Called once per frame before the physics step. */
  sample(dt: number): InputState {
    const s = this.state;
    if (!this.enabled) {
      s.throttle = 0;
      s.steer = 0;
      s.brake = 0;
      s.boost = 0;
      s.handbrake = 0;
      s.overviewHeld = held.overview;
      s.interactHeld = held.interact || held.repair;
      this.steerSmooth = 0;
      return s;
    }

    const pad = this.pollGamepad();
    let throttle = (held.fwd ? 1 : 0) - (held.back ? 1 : 0);
    let steerTarget = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    let brake = held.brake ? 1 : 0;
    let boost = held.boost ? 1 : 0;
    let handbrake = held.handbrake ? 1 : 0;

    if (pad && pad.active) {
      s.gamepad = true;
      throttle = clamp(throttle + pad.throttle, -1, 1);
      if (Math.abs(pad.steer) > Math.abs(steerTarget)) steerTarget = pad.steer;
      brake = Math.max(brake, pad.brake);
      boost = Math.max(boost, pad.boost);
      handbrake = Math.max(handbrake, pad.handbrake ? 1 : 0);
    }

    // Digital steering is ramped so keyboard play still feels analogue.
    const rate = steerTarget === 0 ? 9 : 5.2;
    const step = rate * dt;
    const diff = steerTarget - this.steerSmooth;
    this.steerSmooth += clamp(diff, -step, step);

    s.throttle = throttle;
    s.steer = clamp(this.steerSmooth, -1, 1);
    s.brake = brake;
    s.boost = boost;
    s.handbrake = handbrake;
    s.overviewHeld = held.overview;
    s.interactHeld = held.interact || held.repair || (pad?.interact ?? false);
    return s;
  }
}

export const input = new InputManager();
