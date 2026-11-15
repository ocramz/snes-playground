/**
 * `bind-views` (reference §9): the only code that adds or removes `Ref`.
 * - an entity with a Visual and no Ref gets the view its kind's factory
 *   makes (self-healing: after a scene restart everything rebinds);
 * - a Visual removed (or its entity destroyed) releases the view;
 * - a Visual whose kind changed (an enemy taken -> 'star', the last enemy ->
 *   'cup') is released and rebound with the new kind's view.
 * The tracking modifiers live at module scope, one instance per consumer
 * (reference §16); `primeBindings` creates their queries before any destroy
 * so the first Removed is seen.
 */
import { createChanged, createQuery, createRemoved, Not, type World } from 'koota';
import { Visual } from '../../core/traits/visual';
import { Ref } from './traits';
import type { ViewRegistry } from './view-registry';

const Removed = createRemoved();
const Changed = createChanged();
const unbound = createQuery(Visual, Not(Ref));

export function primeBindings(world: World): void {
  world.query(Removed(Visual));
  world.query(Changed(Visual));
}

export function bindViews(world: World, views: ViewRegistry): void {
  for (const e of world.query(Removed(Visual))) views.release(e);
  for (const e of world.query(Changed(Visual))) {
    const v = views.get(e);
    if (v && e.isAlive() && e.get(Visual)!.kind !== v.kind) views.release(e);
  }
  for (const e of world.query(unbound)) {
    const kind = e.get(Visual)!.kind;
    const view = views.create(e, kind);
    e.add(Ref({ view }));
  }
}
