/**
 * The still-frame counter ($81:A5CD): shot over after 30 frames of
 * |vx| + |vy| < restSpeed while grounded. Runs after the ball step, before
 * the flow reads $D9BE (plan schedule item 29).
 */
import { s16 } from '../fixed';
import type { Work } from './context';

export function countStill(w: Work, dededeActive = false): void {
  if (w.holed >= 2) {
    w.over = 1; // $81:A612
    return;
  }
  if (w.air !== 0) return; // $81:A5DA: airborne -> no change
  if (w.stillGate !== 0) {
    // $81:A5FD: $D9C2 (set by the hazard path) resets the count
    w.frames = 0;
    return;
  }
  const speed = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  if (speed >= w.restSpeed) {
    w.frames = 0; // $81:A5FD
    return;
  }
  if (dededeActive) {
    w.over = 1; // $81:A612
    return;
  }
  w.frames += 1;
  if (w.frames >= 30) w.over = 1; // $81:A612
}
