/**
 * The outline wall ($82:9019), ported byte for byte. Tiles $28-$2D draw
 * the play-area outline as a line through the cell; a ball that crosses
 * the line is reflected without loss and put back where it was, including
 * its height ($82:ECD7), with the probe fields restored ($81:87CA) —
 * verified frame by frame by the web demo (docs/tiles.md).
 */
import { s16, wrap16 } from '../fixed';
import type { Ctx, Work } from './context';
import { restorePrev } from './wall-step';

/** $82:92C2: which side of the tile's line the sub-cell position is on. */
function lineSide(tile: number, xf: number, yf: number): number {
  // The fractions are unsigned 16-bit; the ROM builds each side value as a
  // 32-bit difference ($82:92DC-$82:9338) and tests its sign ($82:9338).
  let v: number;
  switch (tile) {
    case 0: v = xf - 0x8000; break; // x = 1/2
    case 1: v = yf - 0x8000; break; // y = 1/2
    case 2: v = xf + yf - 0x8000; break; // x + y = 1/2
    case 3: v = yf - xf - 0x8000; break; // y - x = 1/2
    case 4: v = xf + yf - 0x18000; break; // x + y = 3/2
    default: v = yf - xf + 0x8000; break; // y - x = -1/2 ($2D)
  }
  return v < 0 ? 0 : 1;
}

/** The per-tile reflections ($82:913E's table). */
function reflectByTile(ctx: Ctx, w: Work, tile: number): void {
  switch (tile) {
    case 0: // $28: vx = -vx
      w.vx = wrap16(-s16(w.vx));
      break;
    case 1: // $29: vy = -vy
      w.vy = wrap16(-s16(w.vy));
      break;
    case 2: // $2A: (vx, vy) <- (-vy, -vx)
    case 4: // $2C
      {
        const vx = w.vx;
        w.vx = wrap16(-s16(w.vy));
        w.vy = wrap16(-s16(vx));
      }
      break;
    default: // $2B, $2D: swap
      {
        const vx = w.vx;
        w.vx = w.vy;
        w.vy = vx;
      }
      break;
  }
  void ctx;
}

/**
 * $82:9019. During play $6AC0 = 2 ($82:C027), so the tail always takes the
 * presentation path: restore x/y/z ($82:ECD7), restore the probe fields
 * ($81:87CA) and queue sfx 7; the object spawn is phase 5. The silent
 * path ($6AC0 = 0, the shot guide) restores only x/y + the probe fields
 * and recomputes the heading.
 */
export function outlineWall(ctx: Ctx, w: Work): void {
  const { rules } = ctx;
  const t = w.tile - 0x28;
  if (w.cell === w.pCell) {
    // $9090: same cell; the crossing is a side flip of one line
    const cur = lineSide(t, w.xf, w.yf);
    const prev = lineSide(t, w.pXf, w.pYf);
    if (cur === prev) {
      w.wallCode = 0; // $908A
      return;
    }
    w.wallVariant = 1; // $0E
    w.wallTileRef = t; // $10
    reflectByTile(ctx, w, t);
    outlineTail(ctx, w);
    return;
  }
  // $902A: the ball moved cells; the previous cell must carry a line too
  const pTile = w.pTile;
  if (pTile < 0x28 || pTile >= 0x2e) {
    w.wallCode = 0;
    return;
  }
  const pt = pTile - 0x28;
  // $903D: the movement code; only cardinal cell moves continue
  const dy = s16(wrap16(w.pYc - w.yc));
  const dx = s16(wrap16(w.pXc - w.xc));
  const move = 3 * (dy + 1) + (dx + 1);
  if ((move & 1) === 0) {
    w.wallCode = 0; // LSR carry clear
    return;
  }
  const dir = move >> 1; // 0..3 = -y, -x, +x, +y
  // $9067: the line must reach the edge the ball exits through
  if (rules.table('outlineLineTouch')[pt * 4 + dir] === 0) {
    w.wallCode = 0;
    return;
  }
  // $9076: the new cell's line must continue the old one
  const cont = rules.table('outlineContinuation');
  if (pt !== cont[dir * 4] && pt !== cont[dir * 4 + 1] && pt !== cont[dir * 4 + 2]) {
    w.wallCode = 0;
    return;
  }
  // $90BF: the connection matrix by (prev side, cur side)
  const prevSide = lineSide(pt, w.pXf, w.pYf);
  const curSide = lineSide(t, w.xf, w.yf);
  let code = rules.table('outlineConnect')[(prevSide * 2 + curSide) * 36 + pt * 6 + t];
  if (code !== 0 && code === w.wallCode) code = (code ^ 3) & 0x3; // $82:9109
  w.wallCode = code;
  // $911C: 0 -> no wall ($908A); 1 -> reflect by the current tile;
  // 2 -> reflect by the previous tile
  if (code === 0) return;
  w.wallVariant = code === 2 ? 1 : 0; // $0E
  w.wallTileRef = code === 2 ? pt : t; // $10
  reflectByTile(ctx, w, w.wallTileRef);
  outlineTail(ctx, w);
}

/** $82:9185: the wall fact, the restore and the sfx. */
function outlineTail(_ctx: Ctx, w: Work): void {
  w.hitWall += 1; // $DA52 (INC at $82:9185)
  w.tailSfx = 7; // $82:91E6 plays it directly; the tail emits the event
  // $82:ECD7: restore x, y and z; $81:87CA: restore the probe fields
  restoreFullPrev(w);
  // the object spawn at the wall point ($82:9196-$82:91D9) is phase 5
}

function restoreFullPrev(w: Work): void {
  restorePrev(w); // $81:87CA restores the probe fields too
  w.z = w.pZ; // $82:ECD7 restores the height as well
}
