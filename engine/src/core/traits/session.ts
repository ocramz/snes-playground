/**
 * World singleton (AoS): the game in progress — the ROM rules, the ordered
 * holes of the course, which one is being played, and the kernel context
 * built for it. It replaces phase 5's module-level `loaded`, so two worlds
 * in one process (the test runner) never share a course.
 */
import { trait } from 'koota';
import type { RomRules } from '../rules';
import type { CourseData } from '../course-data';
import type { Ctx } from '../sim/context';

export interface SessionState {
  rules: RomRules | null;
  courses: CourseData[];
  /** The hole being played (index into `courses`), -1 none. */
  holeIndex: number;
  /** The context the schedule runs the current hole with. */
  ctx: Ctx | null;
  /** `$6A5A`: the ROM course (0-7, 8-15 the extra game), -1 for the courses outside the save (test, random). */
  course: number;
}

export const Session = trait((): SessionState => ({ rules: null, courses: [], holeIndex: -1, ctx: null, course: -1 }));

/** World tag: the frame is skipped while it is present (`pause`/`resume`). */
export const IsPaused = trait();
