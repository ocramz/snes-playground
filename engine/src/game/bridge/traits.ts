/**
 * View-only traits (reference §9): only `bind-views` adds or removes them,
 * core never knows they exist.
 */
import { trait } from 'koota';
import type { View } from './view';

/** The entity's view (its Phaser objects), while bound. */
export const Ref = trait((): { view: View | null } => ({ view: null }));
