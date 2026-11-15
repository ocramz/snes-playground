/**
 * random.html: a course of random holes (plans/random_holes.md). The same
 * game as index.html with the random course's own menu, which generates the
 * holes from a seed (?seed=N, ?difficulty=easy|normal|hard).
 */
import { bootGame } from './game/boot-game';
import { RandomMenuScene } from './game/scenes/random-menu-scene';

bootGame(RandomMenuScene);
