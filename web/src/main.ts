import { createGame } from './game';
import { BootScene } from './scenes/BootScene';
import { TitleScene } from './scenes/TitleScene';
import { HoleScene } from './scenes/HoleScene';
import { ResultScene } from './scenes/ResultScene';

createGame([BootScene, TitleScene, HoleScene, ResultScene]);
