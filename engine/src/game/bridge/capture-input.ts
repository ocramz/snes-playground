/**
 * `capture-input` (reference §10, "capture for frameloop"): the keyboard ->
 * the pad's bits in the SNES layout (core/traits/pad.ts); core sees only
 * `Pad.raw`. Keys are tracked by their DOM events, so a press shorter than
 * a host frame still reaches the next core frame (it is latched until read).
 *
 *   arrows  the d-pad        Z, Space  A        X  Y        C  B
 *   Enter   START            Q / W     L / R
 */
import Phaser from 'phaser';

export const KEY_BITS: Readonly<Record<string, number>> = {
  ArrowUp: 0x0800,
  ArrowDown: 0x0400,
  ArrowLeft: 0x0200,
  ArrowRight: 0x0100,
  KeyZ: 0x0080,
  Space: 0x0080,
  KeyX: 0x4000,
  KeyC: 0x8000,
  Enter: 0x1000,
  KeyQ: 0x0020,
  KeyW: 0x0010,
};

export class Controls {
  private held = 0;
  private latched = 0;
  private readonly counts = new Map<number, number>();

  constructor(private readonly keyboard: Phaser.Input.Keyboard.KeyboardPlugin | null) {
    if (!keyboard) return;
    keyboard.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, this.onDown, this);
    keyboard.on(Phaser.Input.Keyboard.Events.ANY_KEY_UP, this.onUp, this);
    keyboard.addCapture([
      Phaser.Input.Keyboard.KeyCodes.UP, Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.LEFT, Phaser.Input.Keyboard.KeyCodes.RIGHT,
      Phaser.Input.Keyboard.KeyCodes.SPACE,
    ]);
  }

  private onDown(ev: KeyboardEvent): void {
    const bit = KEY_BITS[ev.code];
    if (!bit || ev.repeat) return;
    this.counts.set(bit, (this.counts.get(bit) ?? 0) + 1);
    this.held |= bit;
    this.latched |= bit;
  }

  private onUp(ev: KeyboardEvent): void {
    const bit = KEY_BITS[ev.code];
    if (!bit) return;
    const n = Math.max(0, (this.counts.get(bit) ?? 1) - 1);
    this.counts.set(bit, n);
    if (n === 0) this.held &= ~bit;
  }

  /** The pad for the next core frame: what is down, plus what went down since the last read. */
  read(): number {
    const v = this.held | this.latched;
    this.latched = 0;
    return v & 0xffff;
  }

  /** Forget every key (focus lost: the key-ups will not arrive). */
  clear(): void {
    this.held = 0;
    this.latched = 0;
    this.counts.clear();
  }

  dispose(): void {
    this.keyboard?.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, this.onDown, this);
    this.keyboard?.off(Phaser.Input.Keyboard.Events.ANY_KEY_UP, this.onUp, this);
  }
}
