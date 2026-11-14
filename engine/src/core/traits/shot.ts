import { trait } from 'koota';

/**
 * The shot's aim and elevation ($D9B4/$D9B6): 0 grounder, 60 fly shot,
 * 65 Hi-Jump. The flow systems (phase 5) own them; the ball step reads
 * them through the work copy.
 */
export const Shot = trait({ aim: 0, elev: 0, power: 0 });
