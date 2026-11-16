/**
 * Shared types for the ball step and the tile dispatch.
 */
export interface DispatchOutcome {
  next: 'landing' | 'rolling' | 'done';
  /** Where to enter the default chain:
   *  - full: from $81:8905's top (the lock-out and ground tests);
   *  - grounded: from $81:892B (z = ground onward; the kicker's entry);
   *  - gravityOnly: only the $81:899F gravity tail (the cup's exits). */
  entry?: 'full' | 'grounded' | 'gravityOnly';
  /**
   * The shot guide's water ($81:B144): land on this surface instead of the
   * probe's, which stays as it is (the guide sets z and reflects with the
   * code, `$81:B161`-`$81:B19C`).
   */
  surface?: { ground: number; code: number };
}

export const LANDING: DispatchOutcome = { next: 'landing', entry: 'full' };
export const ROLLING: DispatchOutcome = { next: 'rolling' };
export const DONE: DispatchOutcome = { next: 'done' };
