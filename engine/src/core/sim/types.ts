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
}

export const LANDING: DispatchOutcome = { next: 'landing', entry: 'full' };
export const ROLLING: DispatchOutcome = { next: 'rolling' };
export const DONE: DispatchOutcome = { next: 'done' };
