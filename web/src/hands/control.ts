// The webcam and the hand model (@ocramz/handpose), turned into the grip of
// src/hands/gesture.ts, with a small inset that shows what the camera sees.
// It runs its own requestAnimationFrame loop, independent of Phaser's, so the
// model is already warm (and the camera prompt answered) on the title screen.
//
// ?fakehands replaces the camera and the model with window.__hands.set(...), for
// the e2e scripts (test/e2e/hands.mjs).

import { CameraModel, HandPose, drawDebug, openWebcam, vec3, type FrameSource, type HandView } from '@ocramz/handpose';
import { GripTracker, PALM, handShape, type GripOptions, type GripState, type HandSample, type Shape, type Shot } from './gesture';

export interface HandControlOptions {
  engine: 'ort' | 'tract';
  /** no camera, no model: window.__hands drives the grip */
  fake: boolean;
  grip: Partial<GripOptions>;
}

export interface HandElements {
  box: HTMLElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
}

/** One hand for window.__hands.set: screen-plane metres (x right, y up) and its shape. */
export interface FakeHand { x: number; y: number; shape: Shape | null }

const blank = (): HandSample => ({ active: false, x: 0, y: 0, shape: null });

/**
 * The webcam's horizontal field of view (degrees), a typical laptop camera. It scales the
 * depth only: on the screen plane the metres are pixels times palm length over palm pixels,
 * whatever the field of view, so the grip does not depend on it.
 */
const WEBCAM_HFOV = 60;

export class HandControl {
  readonly grip: GripTracker;
  private pose: HandPose | null = null;
  private source: FrameSource | null = null;
  private readonly cam = new CameraModel();
  private readonly samples: [HandSample, HandSample] = [blank(), blank()];
  /** palm centres in source pixels, for the inset */
  private readonly palmPx: [number, number][] = [[0, 0], [0, 0]];
  private fakeHands: [FakeHand | null, FakeHand | null] = [null, null];
  private message = 'starting the camera...';
  private last = 0;
  private readonly tmp = vec3();
  private readonly ctx: CanvasRenderingContext2D;

  constructor(readonly opts: HandControlOptions, private readonly el: HandElements) {
    this.grip = new GripTracker(opts.grip);
    this.ctx = el.canvas.getContext('2d')!;
  }

  get state(): GripState { return this.grip.state; }

  /** The shot the hands made, once. */
  takeShot(): Shot | null { return this.grip.takeShot(); }

  /** Forget a grip and a pending shot (a new hole). */
  reset(): void { this.grip.reset(); }

  async start(): Promise<void> {
    requestAnimationFrame(this.frame);
    // for the e2e scripts: the controller, and with ?fakehands the stand-in for the model
    (window as unknown as { __hands: unknown }).__hands = {
      set: (l: FakeHand | null, r: FakeHand | null) => { this.fakeHands = [l, r]; },
      control: this,
    };
    if (this.opts.fake) {
      this.message = 'fake hands (window.__hands)';
      return;
    }
    try {
      this.source = await openWebcam();
    } catch (e) {
      this.message = `no camera (${e instanceof Error ? e.message : String(e)}): keys only`;
      return;
    }
    this.source.element.classList.add('cam-video');
    this.el.box.prepend(this.source.element);
    this.cam.set(this.source.width, this.source.height, WEBCAM_HFOV, true);
    this.message = 'loading the hand model...';
    this.pose = new HandPose({
      engine: this.opts.engine,
      onProgress: (m) => { this.message = m; },
      onFatal: (m) => { this.message = m; console.error('[hands]', m); },
    });
  }

  private readonly frame = (): void => {
    requestAnimationFrame(this.frame);
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.1, now - this.last) : 0;
    this.last = now;
    if (this.opts.fake) this.readFake();
    else if (this.pose && this.source) {
      this.pose.pump(now, this.source, true);
      this.pose.updateViews(dt, this.cam);
      this.pose.views.forEach((v, i) => this.readView(v, i));
    }
    this.grip.update(now, this.samples);
    this.draw();
  };

  /** A tracked hand: its palm centre on the screen plane (metres) and its shape. */
  private readView(v: HandView, i: number): void {
    const s = this.samples[i];
    s.active = v.active;
    if (!v.active) { s.shape = null; return; }
    let x = 0, y = 0, px = 0, py = 0;
    for (const k of PALM) {
      v.point(k, this.tmp);
      x += this.tmp.x; y += this.tmp.y;
      px += v.kp[3 * k]; py += v.kp[3 * k + 1];
    }
    s.x = x / PALM.length; s.y = y / PALM.length;
    this.palmPx[i][0] = px / PALM.length; this.palmPx[i][1] = py / PALM.length;
    s.shape = handShape(v.kp);
  }

  private readFake(): void {
    for (let i = 0; i < 2; i++) {
      const f = this.fakeHands[i], s = this.samples[i];
      s.active = !!f;
      if (f) { s.x = f.x; s.y = f.y; s.shape = f.shape; }
    }
  }

  // ---- the inset ---------------------------------------------------------------

  private draw(): void {
    const { canvas, box, status } = this.el;
    const dpr = window.devicePixelRatio || 1;
    const cw = box.clientWidth, ch = box.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    const g = this.grip.state;
    let ends: [number, number][] | null = null;
    if (this.pose) {
      drawDebug(ctx, this.cam, this.pose.raw, this.pose.views, dpr);
      if (g.both) ends = this.palmPx.map(([x, y]) => this.cam.toCanvas(x, y, cw, ch));
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // fake hands: 1 m across the inset, centred
      const k = cw / 1.0;
      ends = this.samples.map((s) => [cw / 2 + s.x * k, ch / 2 - s.y * k]);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.samples.forEach((s, i) => {
        if (!s.active) return;
        ctx.fillStyle = s.shape === 'fist' ? '#ffd34d' : s.shape === 'open' ? '#8ef08a' : '#bbbbbb';
        ctx.beginPath(); ctx.arc(ends![i][0], ends![i][1], 8, 0, Math.PI * 2); ctx.fill();
      });
      if (!g.both) ends = null;
    }
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ends) {
      ctx.strokeStyle = g.grip ? '#ffd34d' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = g.grip ? 4 : 2;
      ctx.beginPath(); ctx.moveTo(ends[0][0], ends[0][1]); ctx.lineTo(ends[1][0], ends[1][1]); ctx.stroke();
    }
    // the energy along the bottom edge, as the shot panel's gauge would show it
    if (g.both) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(6, ch - 12, cw - 12, 6);
      ctx.fillStyle = g.grip ? '#ff5a4d' : 'rgba(255,255,255,0.5)';
      ctx.fillRect(6, ch - 12, ((cw - 12) * g.meter) / 63, 6);
    }
    ctx.restore();

    const shapes = this.samples.map((s) => (s.active ? (s.shape ?? '?') : '-')).join(' / ');
    const line = g.both
      ? `${g.grip ? 'GRIP' : 'hands'} ${shapes} · tilt ${g.angle >= 0 ? '+' : ''}${g.angle.toFixed(0)}° · ${(g.dist * 100).toFixed(0)} cm · ${g.meter}/63`
      : `hands ${shapes}`;
    const head = this.pose?.ready ? this.pose.statusLine() : this.message;
    const text = `${head}\n${line}`;
    if (status.textContent !== text) status.textContent = text;
  }
}
