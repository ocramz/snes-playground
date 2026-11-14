import { trait } from 'koota';

/** World singleton: the core frame counter. Advanced by `advance-frame`. */
export const Time = trait({ frame: 0 });
