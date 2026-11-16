/**
 * editor.html's menu scene (the level editor, docs/editor.md). Registered
 * as SceneKeys.Menu, so every way out of a hole comes back here: the Result
 * card's Enter or Esc, the pause menu's QUIT, the flow's Idle. The page's
 * app (src/editor/app.ts) decides what happens next through host.level:
 * - while the editor is up, this scene is the game's idle state (the page
 *   hides the canvas), and the first time it comes up it tells the app the
 *   assets are in;
 * - after a level was played: ENTER plays it again, E opens the editor.
 */
import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import { addText } from '../features/text/font';
import type { Host, SceneData } from '../host';

export class LevelMenuScene extends Phaser.Scene {
  private host!: Host;

  constructor() {
    super(SceneKeys.Menu);
  }

  init(data: SceneData): void {
    this.host = data.host;
  }

  create(): void {
    const host = this.host;
    host.screen.hudHidden = true;
    host.audio?.stopAll();
    this.cameras.main.setBackgroundColor(0x0b0b14);
    const hooks = host.level ?? null;
    if (!host.rules) {
      addText(this, 24, 96, 'NO RULES: SEE THE CONSOLE');
      return;
    }
    if (hooks?.mode() === 'play') {
      addText(this, 56, 88, host.set?.label ?? 'LEVEL');
      addText(this, 56, 120, 'ENTER  PLAY AGAIN');
      addText(this, 56, 136, 'E      EDIT');
      const kb = this.input.keyboard;
      if (kb) {
        const onKey = (ev: KeyboardEvent): void => {
          if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') hooks.retry();
          else if (ev.code === 'KeyE') hooks.edit();
        };
        kb.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey);
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => kb.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey));
      }
    }
    hooks?.menuReady(this);
  }
}
