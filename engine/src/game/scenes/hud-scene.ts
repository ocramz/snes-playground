/**
 * The score panel (reference §14 A: a parallel scene that reads the world).
 * hud_panel.png is the game's own BG3 panel with its numbers and tomatoes
 * blanked (tools/export_web.py build_hud); the hole, the shot, the tomatoes
 * and the stars are drawn back where hud.json says. The blanked portrait box
 * shows the copy ability's icon as the game does (`$84:99FA`: the picture
 * core's `AbilityFx.hud.icon` names, its ground tinted with `hud.ground`),
 * the lives beside it; without hud_ability.png the lives fill the box. The
 * enemies left have no slot on the original panel and are not drawn. World singletons do
 * not appear in queries, so the values are dirty-checked.
 */
import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import { Tex } from '../assets/keys';
import { addText, setGameText } from '../features/text/font';
import { hudState, type HudState } from '../features/hud/hud-state';
import { snesRgb } from '../features/kirby/kirby-recolour';
import type { Host, SceneData } from '../host';

export class HudScene extends Phaser.Scene {
  private host!: Host;
  private root!: Phaser.GameObjects.Layer;
  private hole!: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;
  private shot!: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;
  private stars!: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;
  private lives!: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;
  private tomatoes: Phaser.GameObjects.Image[] = [];
  private icon: Phaser.GameObjects.Image | null = null;
  private iconGround: Phaser.GameObjects.Image | null = null;
  private last = '';

  constructor() {
    super(SceneKeys.Hud);
  }

  init(data: SceneData): void {
    this.host = data.host;
    this.tomatoes = [];
    this.icon = null;
    this.iconGround = null;
    this.last = '';
  }

  create(): void {
    const hud = this.host.assets.hud;
    const at = hud?.at ?? [16, 176];
    const slots = hud?.slots ?? {
      hole: [111, 194], shot: [136, 193], tomato: [164, 183], tomatoStep: 16, stars: [200, 200], portrait: [24, 184, 48, 208],
    };
    this.root = this.add.layer();
    if (this.textures.exists(Tex.hudPanel)) this.root.add(this.add.image(at[0], at[1], Tex.hudPanel).setOrigin(0, 0));
    for (let k = 0; k < 4; k++) {
      if (!this.textures.exists(Tex.hudTomato)) break;
      this.tomatoes.push(this.add.image(slots.tomato[0] + slots.tomatoStep * k, slots.tomato[1], Tex.hudTomato).setOrigin(0, 0));
    }
    this.root.add(this.tomatoes);
    this.hole = addText(this, slots.hole[0] + 4, slots.hole[1] + 3, '');
    this.shot = addText(this, slots.shot[0] + 1, slots.shot[1] + 3, '');
    this.stars = addText(this, slots.stars[0], slots.stars[1], '');
    const [px0, py0, px1, py1] = slots.portrait;
    const ab = hud?.ability;
    if (ab && this.textures.exists(Tex.hudAbility)) {
      const tex = this.textures.get(Tex.hudAbility);
      for (const [desc, k] of Object.entries(ab.cells)) {
        tex.add(`p${desc}`, 0, k * ab.cell, 0, ab.cell, ab.cell);
        tex.add(`g${desc}`, 0, k * ab.cell, ab.cell, ab.cell, ab.cell);
      }
      this.iconGround = this.add.image(ab.at[0], ab.at[1], Tex.hudAbility).setOrigin(0, 0).setVisible(false);
      this.icon = this.add.image(ab.at[0], ab.at[1], Tex.hudAbility).setOrigin(0, 0).setVisible(false);
      this.root.add([this.iconGround, this.icon]);
      this.lives = addText(this, ab.at[0] + ab.cell + 2, py1 - 8, '');
    } else {
      this.lives = addText(this, px0 + Math.floor((px1 - px0) / 2) - 8, py0 + Math.floor((py1 - py0) / 2) - 4, '');
    }
    this.root.add([this.hole, this.shot, this.stars, this.lives]);
    this.root.setVisible(false);
  }

  update(): void {
    const s = this.host.screen.hudHidden ? null : hudState(this.host.world);
    this.root.setVisible(s !== null);
    if (!s) return;
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    this.draw(s);
  }

  private draw(s: HudState): void {
    setGameText(this.hole, String(s.hole));
    setGameText(this.shot, String(s.shot).padStart(2, ' '));
    setGameText(this.stars, String(s.stars).padStart(2, ' '));
    setGameText(this.lives, `x${s.lives}`);
    this.tomatoes.forEach((t, k) => t.setVisible(k < s.tomatoes));
    const name = s.icon.toString(16).toUpperCase().padStart(4, '0');
    const tex = this.textures.exists(Tex.hudAbility) ? this.textures.get(Tex.hudAbility) : null;
    if (this.icon && this.iconGround && tex?.has(`p${name}`)) {
      this.icon.setFrame(`p${name}`).setVisible(true);
      this.iconGround.setFrame(`g${name}`).setTint(snesRgb(s.ground)).setVisible(true);
    } else {
      this.icon?.setVisible(false);
      this.iconGround?.setVisible(false);
    }
  }
}
