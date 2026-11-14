/**
 * The per-scene map entity -> view (reference §9 "View registry"): needed for
 * teardown because a destroyed entity's traits are gone. `create` asks the
 * catalog for the kind's factory.
 */
import type Phaser from 'phaser';
import type { Entity } from 'koota';
import { Ref } from './traits';
import type { View, ViewFactory } from './view';
import type { Host } from '../host';

export class ViewRegistry {
  private readonly views = new Map<Entity, View>();
  /** The depth sort's y of each view this frame (sync-transforms writes it). */
  readonly sortY = new Map<Entity, number | null>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly host: Host,
    private readonly catalog: Readonly<Record<string, ViewFactory>>,
  ) {}

  create(e: Entity, kind: string): View | null {
    const make = this.catalog[kind];
    if (!make) return null;
    const v = make(this.scene, this.host);
    this.views.set(e, v);
    return v;
  }

  get(e: Entity): View | undefined {
    return this.views.get(e);
  }

  has(e: Entity): boolean {
    return this.views.has(e);
  }

  entries(): IterableIterator<[Entity, View]> {
    return this.views.entries();
  }

  release(e: Entity): void {
    const v = this.views.get(e);
    if (v) v.destroy();
    this.views.delete(e);
    this.sortY.delete(e);
    if (e.isAlive() && e.has(Ref)) e.remove(Ref);
  }

  releaseAll(): void {
    for (const e of [...this.views.keys()]) this.release(e);
  }
}
