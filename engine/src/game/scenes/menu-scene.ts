/**
 * The course choice (reference §7: menus call actions). The title, the
 * map and the player's name are out of scope (plans): Up/Down picks a course
 * set, Enter or Z starts it (`startCourse`), a digit picks and starts. A ROM
 * course is loaded when it is picked (assets/course-loader.ts); ?course=N
 * picks ROM course N at once.
 */
import Phaser from 'phaser';
import { Save, touchSave } from '../../core/traits/save';
import { newMember } from '../../core/save';
import { SceneKeys } from '../scene-keys';
import { startCourse, startHole } from '../../core/actions';
import { addText, setGameText } from '../features/text/font';
import { isLoaded } from '../assets/course-sets';
import { loadCourse } from '../assets/course-loader';
import type { Host, SceneData } from '../host';

const TOP = 72;
const LINE = 12;

export class MenuScene extends Phaser.Scene {
  private host!: Host;
  private choice = 0;
  private busy = false;
  private lines: Array<Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text> = [];
  private status: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text | null = null;

  constructor() {
    super(SceneKeys.Menu);
  }

  init(data: SceneData): void {
    this.host = data.host;
    this.choice = 0;
    this.busy = false;
    this.lines = [];
    this.status = null;
  }

  create(): void {
    this.host.screen.hudHidden = true;
    this.host.audio?.stopAll();
    this.cameras.main.setBackgroundColor(0x0b0b14);
    addText(this, 64, 48, 'SELECT A COURSE');
    this.host.sets.forEach((_s, i) => this.lines.push(addText(this, 64, TOP + LINE * i, '')));
    this.status = addText(this, 64, TOP + LINE * this.host.sets.length + 4, '');
    addText(this, 32, 192, 'ARROWS AIM  Z SHOOT');
    addText(this, 32, 208, 'ESC PAUSE');
    this.draw();
    const kb = this.input.keyboard;
    if (kb) {
      const onKey = (ev: KeyboardEvent): void => {
        if (this.busy) return;
        if (ev.code === 'ArrowUp') this.choice = (this.choice + this.host.sets.length - 1) % this.host.sets.length;
        else if (ev.code === 'ArrowDown') this.choice = (this.choice + 1) % this.host.sets.length;
        else if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') void this.start(this.choice);
        else if (/^Digit[1-9]$/.test(ev.code)) void this.start(Number(ev.code.slice(5)) - 1);
        this.draw();
      };
      kb.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => kb.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey));
    }
    const pick = this.host.flags.course;
    if (pick !== null) {
      const i = this.host.sets.findIndex((s) => s.id === `rom${pick}`);
      if (i >= 0) {
        this.choice = i;
        this.draw();
        void this.start(i);
      }
    }
  }

  private draw(): void {
    this.host.sets.forEach((s, i) => setGameText(this.lines[i], `${i === this.choice ? '>' : ' '} ${i + 1} ${s.label}`));
  }

  private async start(i: number): Promise<void> {
    const set = this.host.sets[i];
    if (!set || !this.host.rules || this.busy) return;
    this.busy = true;
    if (!isLoaded(set)) {
      if (this.status) setGameText(this.status, 'LOADING');
      const ok = await loadCourse(this, set);
      if (!this.scene.isActive()) return;
      if (!ok) {
        if (this.status) setGameText(this.status, 'MISSING ASSETS');
        this.busy = false;
        return;
      }
    }
    this.host.set = set;
    // a ROM course is played by the save's member 0 (made if there is none,
    // NAME ENTRY skipped) until the shell's members list exists; the test
    // holes keep no save (port_v2 phase 7)
    const save = this.host.world.get(Save)!;
    const course = set.rom?.course ?? -1;
    if (course >= 0) {
      if (save.data.members[0] === null && newMember(save.data) >= 0) touchSave(save);
      save.member = save.data.members.findIndex((m) => m !== null);
    } else {
      save.member = -1;
    }
    startCourse(this.host.world, this.host.rules, set.holes.map((h) => h.data), course);
    const first = this.host.flags.hole;
    if (first !== null && first > 1 && first <= set.holes.length) startHole(this.host.world, first - 1);
    if (!this.scene.isActive(SceneKeys.Hud)) this.scene.launch(SceneKeys.Hud, { host: this.host });
    this.scene.start(SceneKeys.Hole, { host: this.host });
  }
}
