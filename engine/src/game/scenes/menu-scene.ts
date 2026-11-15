/**
 * The course choice (reference §7: menus call actions). The title, the
 * map and the player's name are out of scope (plans): Up/Down picks a course
 * set, Enter or Z starts it (`startCourse`), a digit picks and starts.
 */
import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import { startCourse, startHole } from '../../core/actions';
import { addText, setGameText } from '../features/text/font';
import type { Host, SceneData } from '../host';

export class MenuScene extends Phaser.Scene {
  private host!: Host;
  private choice = 0;
  private lines: Array<Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text> = [];

  constructor() {
    super(SceneKeys.Menu);
  }

  init(data: SceneData): void {
    this.host = data.host;
    this.choice = 0;
    this.lines = [];
  }

  create(): void {
    this.host.screen.hudHidden = true;
    this.host.audio?.stopAll();
    this.cameras.main.setBackgroundColor(0x0b0b14);
    addText(this, 64, 48, 'SELECT A COURSE');
    this.host.sets.forEach((_s, i) => this.lines.push(addText(this, 64, 80 + 16 * i, '')));
    addText(this, 32, 176, 'ARROWS AIM  Z SHOOT');
    addText(this, 32, 192, 'ESC PAUSE');
    this.draw();
    const kb = this.input.keyboard;
    if (!kb) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.code === 'ArrowUp') this.choice = (this.choice + this.host.sets.length - 1) % this.host.sets.length;
      else if (ev.code === 'ArrowDown') this.choice = (this.choice + 1) % this.host.sets.length;
      else if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') this.start(this.choice);
      else if (/^Digit[1-9]$/.test(ev.code)) this.start(Number(ev.code.slice(5)) - 1);
      this.draw();
    };
    kb.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => kb.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey));
  }

  private draw(): void {
    this.host.sets.forEach((s, i) => setGameText(this.lines[i], `${i === this.choice ? '>' : ' '} ${i + 1} ${s.label}`));
  }

  private start(i: number): void {
    const set = this.host.sets[i];
    if (!set || !this.host.rules) return;
    this.host.set = set;
    startCourse(this.host.world, this.host.rules, set.holes.map((h) => h.data));
    const first = this.host.flags.hole;
    if (first !== null && first > 1 && first <= set.holes.length) startHole(this.host.world, first - 1);
    if (!this.scene.isActive(SceneKeys.Hud)) this.scene.launch(SceneKeys.Hud, { host: this.host });
    this.scene.start(SceneKeys.Hole, { host: this.host });
  }
}
