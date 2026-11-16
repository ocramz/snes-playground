/**
 * The start screen of a shared level (docs/editor.md "Play and edit on one
 * page"). Browsers keep a page's audio stopped until the user interacts with
 * it, so a level that started on its own would play its intro without the
 * song. This screen asks for the click (or Enter or Space) first; the app
 * resumes the audio inside that gesture, then plays the level.
 *
 * It shows "Loading…" until the level is ready (a click meanwhile is kept
 * and starts the level once it is), then the level's name and picture. A
 * key starts the level on its keyup, after the keydown unlocked the audio:
 * a held Enter must not reach the hole, where Enter is Start.
 */
import type { RomRules } from '../core/rules';
import type { Level } from '../core/level/ops';
import type { TerrainStyle } from '../game/features/layers/styled';
import { IsoView } from './iso-view';
import type { Sprites } from './sprites';

export interface GateHooks {
  /** Inside the user's gesture: resume the audio. */
  unlock(): Promise<void>;
  play(): void;
  edit(): void;
}

export interface GateArt {
  rules: RomRules;
  style: TerrainStyle | null;
  sprites: Sprites | null;
}

export class StartGate {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly editButton: HTMLButtonElement;
  private iso: IsoView | null = null;
  private hooks: GateHooks | null = null;
  /** The user asked to play before the level was ready. */
  private pendingStart = false;
  /** A key went down on the screen: the level starts on its keyup. */
  private keyArmed = false;
  private starting = false;
  private readonly onKeyDown = (e: KeyboardEvent): void => this.keyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.keyUp(e);

  constructor(private readonly unlockOnly: () => Promise<void>) {
    this.root = document.createElement('div');
    this.root.id = 'gate';
    this.root.hidden = true;
    const card = document.createElement('div');
    card.className = 'gate-card';
    this.preview = document.createElement('div');
    this.preview.className = 'gate-preview';
    this.title = document.createElement('h1');
    this.title.className = 'gate-title';
    this.playButton = document.createElement('button');
    this.playButton.type = 'button';
    this.playButton.className = 'gate-play';
    this.playButton.addEventListener('click', () => this.start());
    const hint = document.createElement('div');
    hint.className = 'gate-hint';
    hint.textContent = 'or press Enter or Space (sound on)';
    this.editButton = document.createElement('button');
    this.editButton.type = 'button';
    this.editButton.className = 'gate-edit';
    this.editButton.textContent = 'Open in the editor';
    this.editButton.addEventListener('click', () => {
      if (this.hooks) {
        const h = this.hooks;
        this.hide();
        h.edit();
      }
    });
    card.append(this.preview, this.title, this.playButton, hint, this.editButton);
    this.root.appendChild(card);
    document.body.appendChild(this.root);
  }

  get shown(): boolean {
    return !this.root.hidden;
  }

  /** The screen while the assets load and the level decodes. */
  showLoading(): void {
    this.hooks = null;
    this.pendingStart = false;
    this.starting = false;
    this.title.textContent = '';
    this.playButton.textContent = 'Loading…';
    this.editButton.hidden = true;
    this.preview.hidden = true;
    this.open();
  }

  /** The level is ready: its name and picture, and the button that plays it. */
  ready(level: Level, art: GateArt, hooks: GateHooks): void {
    this.hooks = hooks;
    this.starting = false;
    this.title.textContent = level.name || 'LEVEL';
    this.playButton.textContent = '▶ Click to play';
    this.editButton.hidden = false;
    this.preview.hidden = false;
    this.open();
    if (!this.iso) this.iso = new IsoView(this.preview, art.rules, art.style, art.sprites, () => {});
    this.iso.schedule(level);
    this.iso.render();
    if (this.pendingStart) this.start();
    else this.playButton.focus({ preventScroll: true });
  }

  hide(): void {
    this.root.hidden = true;
    this.hooks = null;
    this.pendingStart = false;
    this.keyArmed = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
  }

  private open(): void {
    this.root.hidden = false;
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
  }

  /** The click (or the key's keyup): unlock the audio in the gesture, then play. */
  private start(): void {
    if (this.starting) return;
    const hooks = this.hooks;
    if (!hooks) {
      // still loading: unlock now, play when ready
      this.pendingStart = true;
      this.playButton.textContent = 'Loading… (starts when ready)';
      void this.unlockOnly();
      return;
    }
    this.starting = true;
    void hooks.unlock().then(() => {
      if (this.hooks !== hooks) return; // hidden meanwhile
      this.hide();
      hooks.play();
    });
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.target === this.editButton) return;
    if (e.code !== 'Enter' && e.code !== 'Space' && e.code !== 'NumpadEnter') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    this.keyArmed = true;
    void this.unlockOnly(); // a keydown is a user activation; its keyup is not
  }

  private keyUp(e: KeyboardEvent): void {
    if (e.target === this.editButton) return;
    if (e.code !== 'Enter' && e.code !== 'Space' && e.code !== 'NumpadEnter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.keyArmed) return;
    this.keyArmed = false;
    this.start();
  }
}
