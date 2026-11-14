/** Cleanup callbacks a scene collects next to each subscription, run on SHUTDOWN (reference §15). */
export class Disposables {
  private readonly fns: Array<() => void> = [];

  add(fn: () => void): void {
    this.fns.push(fn);
  }

  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) fn();
  }
}
