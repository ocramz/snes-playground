/**
 * The page's side of the par worker (solver.worker.ts). One level at a
 * time: asking for another while one is being solved terminates the worker
 * (a solve cannot be interrupted, and the old answer is no longer wanted),
 * and the superseded promise resolves to null.
 */
import type { TablesJson } from '../core/rules';
import type { AuthoredCourseJson } from '../core/course-data';
import type { ShotSpec } from '../core/gen/shot-sim';

export interface SolveRequest {
  kind: 'solve';
  id: number;
  json: AuthoredCourseJson;
}

export interface SolveReply {
  id: number;
  ok: boolean;
  par: number;
  why: string;
  shots: number;
  plan: Array<{ from: { xc: number; xf: number; yc: number; yf: number; z: number }; shot: ShotSpec; holes: boolean }>;
}

export class SolverClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending: { id: number; resolve: (r: SolveReply | null) => void } | null = null;

  constructor(private readonly tables: TablesJson) {}

  solve(json: AuthoredCourseJson): Promise<SolveReply | null> {
    if (this.pending) {
      // the worker is busy with a level nobody wants any more
      this.worker?.terminate();
      this.worker = null;
      this.pending.resolve(null);
      this.pending = null;
    }
    const w = this.spawn();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      w.postMessage({ kind: 'solve', id, json } satisfies SolveRequest);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending?.resolve(null);
    this.pending = null;
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (ev: MessageEvent<SolveReply>) => {
      const p = this.pending;
      if (!p || ev.data.id !== p.id) return;
      this.pending = null;
      p.resolve(ev.data);
    });
    w.addEventListener('error', (ev) => {
      console.error('solver worker', ev.message);
      const p = this.pending;
      this.pending = null;
      this.worker = null;
      p?.resolve({ id: p.id, ok: false, par: 0, why: `the solver failed: ${ev.message}`, shots: 0, plan: [] });
    });
    w.postMessage({ kind: 'rules', tables: this.tables });
    this.worker = w;
    return w;
  }
}
