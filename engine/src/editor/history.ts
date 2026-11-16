/**
 * The editor's undo and redo: the levels themselves (an operation never
 * changes its input, core/level/ops.ts), at most LIMIT back.
 */
import type { Level } from '../core/level/ops';

const LIMIT = 200;

export class History {
  private past: Level[] = [];
  private future: Level[] = [];

  constructor(private current: Level) {}

  get level(): Level {
    return this.current;
  }

  push(next: Level): void {
    if (next === this.current) return;
    this.past.push(this.current);
    if (this.past.length > LIMIT) this.past.shift();
    this.future = [];
    this.current = next;
  }

  /** Replace the current level without an undo step (a rename while typing). */
  amend(next: Level): void {
    this.current = next;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.current);
    this.current = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.current);
    this.current = next;
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
