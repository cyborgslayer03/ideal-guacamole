// Keyboard, mouse, and touch input, merged into one per-frame snapshot.

export type Action = 'attack' | 'dodge' | 'jump' | 'travel' | 'ultimate' | 'skill0' | 'skill1' | 'skill2' | 'skill3' | 'pause';

const KEY_ACTIONS: Record<string, Action> = {
  KeyJ: 'attack',
  ShiftLeft: 'dodge',
  ShiftRight: 'dodge',
  KeyK: 'dodge',
  Space: 'jump',
  KeyV: 'travel',
  KeyX: 'ultimate',
  KeyQ: 'skill0',
  KeyE: 'skill1',
  KeyR: 'skill2',
  KeyF: 'skill3',
  Digit1: 'skill0',
  Digit2: 'skill1',
  Digit3: 'skill2',
  Digit4: 'skill3',
  Escape: 'pause',
  KeyP: 'pause',
};

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<Action>();
  /** Touch joystick vector, -1..1 on each axis (y = forward). */
  readonly stick = { x: 0, y: 0 };
  /** Accumulated camera orbit from mouse drag / touch drag. */
  orbitX = 0;
  orbitY = 0;
  zoom = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (!e.repeat && KEY_ACTIONS[e.code]) this.pressed.add(KEY_ACTIONS[e.code]);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    this.on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    this.on(window, 'blur', () => this.keys.clear());
    this.on(canvas, 'pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.pressed.add('attack');
      this.dragging = e.pointerType !== 'mouse' || e.button === 2;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    this.on(canvas, 'pointermove', (e: PointerEvent) => {
      if (!this.dragging) return;
      this.orbitX += (e.clientX - this.lastX) * 0.006;
      this.orbitY += (e.clientY - this.lastY) * 0.004;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    this.on(canvas, 'pointerup', () => (this.dragging = false));
    this.on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
    this.on(canvas, 'wheel', (e: WheelEvent) => {
      this.zoom += Math.sign(e.deltaY);
      e.preventDefault();
    });
  }

  private on<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void) {
    const listener = fn as EventListener;
    target.addEventListener(type, listener, { passive: false });
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }

  /** Used by on-screen touch buttons. */
  press(action: Action) {
    this.pressed.add(action);
  }

  /** Returns true once per press. */
  consume(action: Action): boolean {
    const had = this.pressed.has(action);
    this.pressed.delete(action);
    return had;
  }

  held(code: string): boolean {
    return this.keys.has(code);
  }

  /** Camera-relative movement input: x = right, y = forward. */
  movement(): { x: number; y: number } {
    let x = this.stick.x;
    let y = this.stick.y;
    if (this.keys.has('KeyW')) y += 1;
    if (this.keys.has('KeyS')) y -= 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /** Arrow keys orbit the camera for players without a mouse. */
  keyOrbit(dt: number) {
    if (this.keys.has('ArrowLeft')) this.orbitX -= dt * 2.5;
    if (this.keys.has('ArrowRight')) this.orbitX += dt * 2.5;
    if (this.keys.has('ArrowUp')) this.orbitY -= dt * 1.5;
    if (this.keys.has('ArrowDown')) this.orbitY += dt * 1.5;
  }

  dispose() {
    this.cleanup.forEach((f) => f());
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
