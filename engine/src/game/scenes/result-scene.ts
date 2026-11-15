/**
 * After the course (CourseDone): the card, the strokes of each hole and
 * their sum (Career.card); Enter ends the game (`endGame`) and goes back
 * to the menu. After GAME OVER: Enter continues (`continueGame`: the
 * course again from its first hole with 2 lives), Esc ends it. The game's
 * own score card, medals and map are out of scope (plans).
 */
import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import { continueGame, endGame } from '../../core/actions';
import { Career } from '../../core/traits/counters';
import { addText } from '../features/text/font';
import type { Host } from '../host';

export interface ResultData {
  host: Host;
  mode: 'course' | 'over';
}

export class ResultScene extends Phaser.Scene {
  private host!: Host;
  private mode: 'course' | 'over' = 'course';

  constructor() {
    super(SceneKeys.Result);
  }

  init(data: ResultData): void {
    this.host = data.host;
    this.mode = data.mode;
  }

  create(): void {
    this.host.screen.hudHidden = true;
    this.cameras.main.setBackgroundColor(0x0b0b14);
    const world = this.host.world;
    if (this.mode === 'over') {
      this.host.audio?.stopAll();
      addText(this, 92, 80, 'GAME OVER');
      addText(this, 52, 120, 'ENTER  CONTINUE');
      addText(this, 52, 136, 'ESC    END');
    } else {
      const card = world.get(Career)!.card;
      addText(this, 64, 24, `${this.host.set?.label ?? 'COURSE'} CLEAR`);
      // a random course's holes also show the solver's par (core/gen)
      const par = (i: number): string => {
        const p = this.host.set?.holes[i]?.par;
        return p === undefined ? '' : `  PAR ${p}`;
      };
      card.forEach((n, i) => addText(this, 72, 48 + 12 * i, `HOLE ${i + 1}   ${n < 0 ? '-' : String(n).padStart(2, ' ')}${par(i)}`));
      const total = card.filter((n) => n >= 0).reduce((a, b) => a + b, 0);
      addText(this, 72, 56 + 12 * card.length, `TOTAL    ${String(total).padStart(2, ' ')}`);
      addText(this, 72, 200, 'PRESS ENTER');
    }
    const kb = this.input.keyboard;
    if (!kb) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (this.mode === 'over' && (ev.code === 'Enter' || ev.code === 'KeyZ')) {
        continueGame(world);
        this.scene.start(SceneKeys.Hole, { host: this.host });
      } else if (ev.code === 'Enter' || ev.code === 'Escape') {
        endGame(world);
        this.scene.start(SceneKeys.Menu, { host: this.host });
      }
    };
    kb.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => kb.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey));
  }
}
