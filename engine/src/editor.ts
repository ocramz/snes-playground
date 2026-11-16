/**
 * editor.html: the level editor (docs/editor.md). The engine's game with
 * the level page's menu scene, and the editor app around it, which reads
 * and writes the level in the URL's hash: no level, the editor on the
 * default one; `#l=...`, the level plays (Edit opens it); `#l=...&edit`,
 * the editor on it.
 */
import './editor/editor.css';
import { bootGame } from './game/boot-game';
import { LevelMenuScene } from './game/scenes/level-menu-scene';
import { LevelApp } from './editor/app';

const { game, host } = bootGame(LevelMenuScene);
new LevelApp(game, host);
