import { trait } from 'koota';

/**
 * What an entity looks like, as a semantic kind (reference §6: "core stores
 * semantics, not assets"). The bridge's view catalog maps a kind to its
 * textures and clips; core never names an asset key.
 *
 * Kinds: 'ball' (Kirby and his ball), 'tee', 'enemy', 'star' (a taken
 * enemy), 'cup', 'pillar', 'hazard'.
 */
export const Visual = trait({ kind: '' });
