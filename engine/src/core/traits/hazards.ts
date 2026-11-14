/**
 * The hole's hazard actors (objects 76, 77, 81-83; docs/tiles.md "Hazards"):
 * their run state, object 76's list ($B6BA) and the cell index ($ABB8).
 * systems/actors.ts sets it up at the hole's start and ticks it.
 */
import { trait } from 'koota';
import type { HazardField } from '../sim/hazards';

/** World singleton (AoS): the hole's hazard actors; ctx.course.hazards is this object. */
export const Hazards = trait((): HazardField => ({ actors: [], list: [], atCell: new Int16Array(0) }));
