/**
 * index.html: the course menu (course 1 of the ROM, the test courses).
 * game/boot-game.ts creates the world and the game.
 */
import { bootGame } from './game/boot-game';
import { MenuScene } from './game/scenes/menu-scene';

bootGame(MenuScene);
