import { trait } from 'koota';

/**
 * The stall ($81:8C79/$81:8C48 hit-stops, the cup reveal $82:8B5C). A
 * system that requests one stores the resume point; the runner suspends
 * the schedule, runs only the stall's own list, and resumes the suspended
 * list when the frames run out (plans/port_v1_koota_phaser4.md, item 3).
 * The suspended step's state rides as plain fields (koota traits hold
 * primitives only).
 */
export const Stall = trait({
  kind: 'none' as 'none' | 'hitStop' | 'stepStop' | 'cupReveal',
  framesLeft: 0,
  resumeAt: -1,
  /** The pad OR-accumulated across the stall's frames ($6A7C/$6A7E). */
  padLatch: 0,
  // the suspended step's route and landing outcome
  pRoute: '' as string,
  pReroute: '' as string,
  pEntry: '' as string,
  pOutcome: '' as string,
});
