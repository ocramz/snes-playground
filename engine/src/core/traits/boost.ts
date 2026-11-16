/**
 * Object 112 ($84:876C): spawned at the hole's load when layer 2 has a boost
 * panel ($30-$3B; `$82:BCD7`). Besides the panels' colour cycle (the bridge's,
 * layers.json `cycles`) it runs a per-frame hook, `$84:87D4`, that hums while
 * the ball rides a panel (systems/boost-hum.ts). `active` is the object's
 * life (the hole has panels), `counter` its `$531C`.
 */
import { trait } from 'koota';

export const BoostHum = trait({ active: 0, counter: 0 });
