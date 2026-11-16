/**
 * The par of a level, off the page's main thread: the random holes' solver
 * (core/gen/solve.ts) on the level as the engine would load it. The page
 * sends the rules once (tables.json as parsed), then a level at a time; a
 * new level while one is being solved replaces the worker (src/editor/solver.ts).
 */
import { RomRules, type TablesJson } from '../core/rules';
import { fromAuthoredCourse, type AuthoredCourseJson } from '../core/course-data';
import { solveNow } from '../core/gen/solve';
import type { SolveReply, SolveRequest } from './solver';

let rules: RomRules | null = null;
const scope = self as unknown as {
  postMessage(m: unknown): void;
  addEventListener(type: 'message', f: (ev: MessageEvent<SolveRequest | { kind: 'rules'; tables: TablesJson }>) => void): void;
};

scope.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.kind === 'rules') {
    rules = new RomRules(m.tables);
    return;
  }
  const reply: SolveReply = { id: m.id, ok: false, par: 0, why: '', plan: [], shots: 0 };
  try {
    if (!rules) throw new Error('no rules');
    const data = fromAuthoredCourse(m.json as AuthoredCourseJson, { enemyAbility: rules.table('enemyAbility') });
    const sol = solveNow(rules, data);
    reply.ok = sol.ok;
    reply.par = sol.par;
    reply.why = sol.why;
    reply.shots = sol.shots;
    reply.plan = sol.plan.map((p) => ({ from: p.from, shot: p.shot, holes: p.holes }));
  } catch (e) {
    reply.why = e instanceof Error ? e.message : String(e);
  }
  scope.postMessage(reply);
});
