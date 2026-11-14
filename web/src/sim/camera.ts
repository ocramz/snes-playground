// The game's camera, ported from the code that writes `$7E:38AC` / `$7E:38AE`
// (`$80:BF4D` turns them into the scroll: x = `$38AC`, y = 456 - `$38AE`, where
// 456 is the course bitmap's height). Y is counted up from the bottom.
//
//   pan     `$81:BA8A`   in the aim stage and while Kirby curls: step toward a focus
//                         point (x: up to 10 px a frame, y: up to 5), (|d| >> 3) + 1
//   follow  `$80:B961`   while the ball rolls: up to 4 px a frame, with a lag that grows
//                         with the ball's speed (24 x its last step, at most $70 / $60 px)
//
// What the focus is, per stage (measured, tools/snesstep/trace_flow.py):
//   aim      the end of the shot guide (src/sim/guide.ts)
//   curl     Kirby + a quarter-dependent offset ($81:BEB4, tables $81:C0F0 / $81:C0F8)
//   roll     Kirby

/** Offsets added to Kirby's projected position for the shot view, by aim quarter ($81:C0F0, $81:C0F8). */
export const SHOT_VIEW_X = [0x50, 0, -0x50, 0];
export const SHOT_VIEW_Y = [0, 0x28, 0, -0x38];

const sign = (v: number): number => (v < 0 ? -1 : 1);

export class Camera {
  /** `$38AC`, `$38AE` */
  x = 0;
  y = 0;
  /** `$38C2/$38C4`: the lag the speed asks for; `$38C6/$38C8`: the lag it has reached */
  private c2 = 0; private c4 = 0; private c6 = 0; private c8 = 0;
  /** `$39D6`: 0 start, 1 easing toward Kirby, 2 locked on */
  private st = 0;
  /** Kirby's projected position (x, height - y) as 16.16 integers, last frame ($DA5E.. $DA64) */
  private prevX = 0; private prevY = 0;

  constructor(readonly height: number) {}

  /** Hole start ($80:C4A7): Kirby in the middle of the screen. */
  snap(kx: number, kyFlip: number): void {
    this.x = Math.floor(kx) - 0x80;
    this.y = Math.floor(kyFlip) + 0x70;
    this.st = 0; this.c6 = this.c8 = 0;
  }

  /** The scroll the PPU gets. */
  get scrollX(): number { return this.x; }
  get scrollY(): number { return this.height - this.y; }

  /** `$81:BA8A`: one step toward the focus (fx, fyFlip). True when both axes were already there. */
  pan(fx: number, fyFlip: number): boolean {
    let arrived = 0;
    const dx = Math.floor(fx) - 0x80 - this.x;
    if (dx === 0) arrived += 1;
    else this.x += sign(dx) * Math.min(10, (Math.abs(dx) >> 3) + 1);
    const dy = Math.floor(fyFlip) + 0x70 - this.y;
    if (dy === 0) arrived += 1;
    else this.y += sign(dy) * Math.min(5, (Math.abs(dy) >> 3) + 1);
    return arrived === 2;
  }

  /**
   * `$82:BFBC`, at the A that shoots: the lag becomes the shot view's offset from Kirby
   * ($38C6 = $6B44 - $DA58, $38C8 = $6B46 - $DA5C), so the camera is where it was and
   * follows rigidly from there ($39D6 = 2 on the real game at that point).
   */
  launch(offsetX: number, offsetY: number): void {
    this.c6 = offsetX; this.c8 = offsetY;
    this.st = 2;
  }

  /** After the cup reveal: ease back to Kirby (4 px a frame) and lock on ($39D6 = 1). */
  ease(): void { this.st = 1; }

  /** Every frame, after the ball moved: remember where Kirby is ($DA5E.. = $DA56..). */
  observe(kx: number, kyFlip: number): void {
    this.prevX = Math.floor(kx * 65536);
    this.prevY = Math.floor(kyFlip * 65536);
  }

  /** `$80:B961`..: the roll. Call with Kirby's position before `observe`. */
  follow(kx: number, kyFlip: number): void {
    const cx = Math.floor(kx * 65536), cy = Math.floor(kyFlip * 65536);
    if (this.st === 0) {
      this.prevX = cx; this.prevY = cy;
      this.c6 = 0; this.c8 = 0;
      this.st = 1;
    }
    this.lag(cx, cy);
    const ix = Math.floor(kx), iy = Math.floor(kyFlip);
    const tx = ix - 0x80 + this.c6;
    const ty = iy + 0x70 + this.c8;
    if (this.st >= 2) {
      this.x = tx; this.y = ty;
      return;
    }
    // $80:BA55: at most 4 px a frame; locked on when the next position is within 2 px
    const dx = tx - this.x, dy = ty - this.y;
    const sx = dx === 0 ? 0 : sign(dx) * Math.min(4, (Math.abs(dx) >> 3) + 1);
    const sy = dy === 0 ? 0 : sign(dy) * Math.min(4, (Math.abs(dy) >> 3) + 1);
    const nx = this.x + sx, ny = this.y + sy;
    if (Math.abs(tx - nx) >= 2 || Math.abs(ty - ny) >= 2) {
      this.x = nx; this.y = ny;
    } else {
      this.x = tx; this.y = ty;
      this.st += 1;
    }
  }

  /** `$80:BAB4`: the lag. 24 x the last step (floor), cut at $70 / $60, opposite to the motion, eased by (|e| >> 5) + 1. */
  private lag(cx: number, cy: number): void {
    const vx = Math.floor(((cx - this.prevX) * 24) / 65536);
    const vy = Math.floor(((cy - this.prevY) * 24) / 65536);
    this.c2 = vx < 0 ? Math.min(-vx, 0x70) : -Math.min(vx, 0x70);
    this.c4 = vy < 0 ? Math.min(-vy, 0x60) : -Math.min(vy, 0x60);
    const ex = this.c2 - this.c6;
    if (ex !== 0) this.c6 += sign(ex) * ((Math.abs(ex) >> 5) + 1);
    const ey = this.c4 - this.c8;
    if (ey !== 0) this.c8 += sign(ey) * ((Math.abs(ey) >> 5) + 1);
  }
}
