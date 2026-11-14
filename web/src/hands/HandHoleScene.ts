// The hole, putted with two hands (src/hands/gesture.ts). In the aim stage:
//   both fists   a grip: the aim is Kirby's heading when the grip started plus the
//                tilt of the line between the hands (1:1, counter-clockwise = Left);
//                the energy is their distance. The guide dots and the game's shot
//                panel (the face and the gauge) show both while the grip lasts.
//   both open    Kirby is pushed with the last aim and energy of the grip
//                (HoleSim.requestShot: no spin stage, no power meter).
// Dropping the hands out of view ends a grip without a shot; the aim stays, so a
// new grip turns further from there. The keyboard works as on the plain page.

import { GAME_H, GAME_W } from '../config';
import { HoleScene } from '../scenes/HoleScene';
import type { PanelState } from '../render/shotpanel';
import type { Pad } from '../sim/hole';
import type { HandControl } from './control';

/** Kirby shows the turning pose for this many frames after the hands moved the aim. */
const TURN_POSE_FRAMES = 8;

export class HandHoleScene extends HoleScene {
  private hands!: HandControl;
  /** a grip is steering the aim (it started in the aim stage) */
  private gripping = false;
  /** the aim when the grip started */
  private heading = 0;
  /** frames the hand panel has been up (its gauge frame slides in over the first 4) */
  private panelAge = 0;
  private turnLeft = 0;

  create(): void {
    this.hands = this.registry.get('hands') as HandControl;
    this.hands.reset();
    this.gripping = false; this.panelAge = 0; this.turnLeft = 0;
    super.create();
  }

  protected stepOnce(pad: Pad): void {
    const sim = this.sim;
    const g = this.hands.state;
    const aimStage = sim.stage === 'aim';
    const before = sim.aim;
    const shot = this.hands.takeShot();
    if (shot && aimStage && this.gripping) {
      sim.setAim(this.heading + Math.round(shot.angle));
      sim.requestShot(shot.meter);
      this.gripping = false;
    } else if (aimStage && g.grip) {
      if (!this.gripping) { this.gripping = true; this.heading = sim.aim; }
      sim.setAim(this.heading + Math.round(g.angle));
    } else {
      this.gripping = false;
    }
    if (sim.aim !== before) this.turnLeft = TURN_POSE_FRAMES;
    else if (this.turnLeft > 0) this.turnLeft -= 1;
    this.panelAge = this.handPanel() ? this.panelAge + 1 : 0;
    super.stepOnce(pad);
  }

  /** The panel is up while a grip steers, and through the curl of a hand shot. */
  private handPanel(): boolean {
    const s = this.sim.stage;
    return (s === 'aim' && this.gripping) || (s === 'curl' && this.sim.handShot);
  }

  protected turning(pad: Pad): boolean { return super.turning(pad) || this.turnLeft > 0; }

  protected shotUi(): boolean { return this.handPanel() || super.shotUi(); }

  protected panelState(): PanelState {
    const p = super.panelState();
    if (!this.handPanel()) return p;
    const aim = this.sim.stage === 'aim';
    // fully open at once (the "1" and the face without the game's 66-frame wait)
    p.visible = true;
    p.age = this.ui.timing.panel + this.panelAge;
    p.side = 6; p.topBack = 6;
    p.meter1 = p.meter2 = aim ? this.hands.state.meter : this.sim.meter;
    // The aim camera looks at the far end of the guide, which can put Kirby at the
    // edge of the screen; keep the whole panel in view (around Kirby's point it spans
    // x -24..+40 and y -40 (the "1") ..+69 (the tomatoes)).
    p.x = Math.max(26, Math.min(GAME_W - 42, p.x));
    p.y = Math.max(42, Math.min(GAME_H - 71, p.y));
    return p;
  }

  protected hintText(): string {
    const s = this.sim.stage;
    if (s === 'aim') return this.gripping ? 'TILT=AIM SPREAD=POWER OPEN=PUTT' : 'TWO FISTS = AIM   KEYS: LR A';
    if (s === 'curl' && this.sim.handShot) return '';
    return super.hintText();
  }
}
