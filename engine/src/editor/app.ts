/**
 * editor.html's app (docs/editor.md): the level editor and the game on one
 * page, and the URL that carries the level (core/level/codec.ts).
 *
 * - No level in the URL: the editor, on the default level.
 * - `#l=<payload>`: the level plays at once; the play bar's Edit opens it in
 *   the editor, Retry plays it again, Copy link shares it.
 * - `#l=<payload>&edit`: the editor on that level (the editor keeps its URL
 *   so, a reload keeps the work).
 *
 * The game is the engine's (game/boot-game.ts) with LevelMenuScene as its
 * menu. While the editor is up the game idles in that scene with its canvas
 * hidden, its loop asleep and its keyboard off (Phaser's keyboard manager
 * cancels the keys it captures only while enabled, so the page's inputs get
 * the arrows and Space back). Every way out of a hole comes back to the menu
 * scene, which offers ENTER to play again and E to edit.
 */
import Phaser from 'phaser';
import type { Host } from '../game/host';
import { SceneKeys } from '../game/scene-keys';
import { Rules, Tex } from '../game/assets/keys';
import { levelCourseSet } from '../game/assets/course-sets';
import { startCourse, endGame, resume } from '../core/actions';
import { HoleFlow } from '../core/traits/flow';
import { Save } from '../core/traits/save';
import type { TablesJson } from '../core/rules';
import type { AuthoredCourseJson } from '../core/course-data';
import { lintLevel, levelJson } from '../core/level/lint';
import { cleanName, decodeLevel, encodeLevel, formatHash, parseHash } from '../core/level/codec';
import { defaultLevel } from '../core/level/default-level';
import type { Level } from '../core/level/ops';
import { Editor } from './editor-ui';
import { Sprites } from './sprites';
import { SolverClient } from './solver';

type Mode = 'loading' | 'edit' | 'play';

const templates = import.meta.glob<AuthoredCourseJson>('../../courses/*.course.json', { eager: true, import: 'default' });
const HASH_DELAY_MS = 300;

export class LevelApp {
  private mode: Mode = 'loading';
  private editor: Editor | null = null;
  private playing: Level | null = null;
  /** Did the level in play come from the editor (its undo history goes on) or from a link? */
  private playFromEditor = false;
  private parSolver: SolverClient | null = null;
  private hashTimer = 0;
  private lastHash = window.location.hash;
  private readonly gameEl: HTMLElement;
  private readonly playBar: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly shareBox: HTMLElement;
  private readonly shareInput: HTMLInputElement;
  private readonly shareNote: HTMLElement;
  private toastTimer = 0;

  constructor(private readonly game: Phaser.Game, private readonly host: Host) {
    this.gameEl = document.getElementById('game')!;
    host.level = {
      mode: () => this.mode,
      menuReady: () => {
        if (this.mode === 'loading') void this.start();
      },
      retry: () => this.retry(),
      edit: () => this.toEditor(),
    };

    this.playBar = document.createElement('div');
    this.playBar.id = 'playbar';
    this.playBar.hidden = true;
    this.barButton('✎ Edit', 'Open this level in the editor', () => this.toEditor());
    this.barButton('↻ Retry', 'Play the level again from the tee', () => this.retry());
    this.barButton('Copy link', 'Copy a link that plays this level', () => {
      if (this.playing) void this.share(this.playing);
    });
    document.body.appendChild(this.playBar);

    this.toastEl = document.createElement('div');
    this.toastEl.id = 'toast';
    this.toastEl.hidden = true;
    document.body.appendChild(this.toastEl);

    this.shareBox = document.createElement('div');
    this.shareBox.id = 'sharebox';
    this.shareBox.hidden = true;
    const title = document.createElement('div');
    title.textContent = 'A link that plays this level:';
    this.shareInput = document.createElement('input');
    this.shareInput.readOnly = true;
    this.shareInput.addEventListener('focus', () => this.shareInput.select());
    this.shareNote = document.createElement('div');
    this.shareNote.className = 'note';
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.addEventListener('click', () => {
      this.shareBox.hidden = true;
    });
    this.shareBox.append(title, this.shareInput, this.shareNote, close);
    document.body.appendChild(this.shareBox);

    window.addEventListener('hashchange', () => {
      if (window.location.hash === this.lastHash) return;
      this.lastHash = window.location.hash;
      if (this.mode !== 'loading') void this.route(window.location.hash);
    });
  }

  /** The assets are in (the menu scene's first create): build the editor, then follow the URL. */
  private async start(): Promise<void> {
    const rules = this.host.rules;
    if (!rules) return; // the menu scene says so
    const tables = (this.game.cache.json.exists(Rules.tables) ? this.game.cache.json.get(Rules.tables) : null) as TablesJson | null;
    const atlasImage = this.game.textures.exists(Tex.atlas)
      ? (this.game.textures.get(Tex.atlas).getSourceImage() as HTMLImageElement)
      : null;
    const sprites = this.host.assets.atlas ? new Sprites(this.host.assets.atlas, atlasImage) : null;
    this.parSolver = tables ? new SolverClient(tables) : null;
    this.editor = new Editor(document.body, {
      rules,
      style: this.host.assets.terrainStyle,
      sprites,
      solver: tables ? new SolverClient(tables) : null,
      templates: Object.entries(templates)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, json]) => ({ name: cleanName(json.name.toUpperCase()), json })),
      onPlay: (level) => this.play(level, true),
      onShare: (level) => void this.share(level),
      onChange: (level) => {
        if (this.mode === 'edit') this.writeHash(level, true);
      },
    }, defaultLevel());
    this.editor.show(false);
    if (this.host.flags.debug) this.exposeDebug();
    await this.route(window.location.hash);
  }

  /** Go where the URL says. */
  private async route(hash: string): Promise<void> {
    const { payload, edit } = parseHash(hash);
    if (!payload) {
      this.toEditor(defaultLevel());
      return;
    }
    let level: Level;
    try {
      level = await decodeLevel(payload);
    } catch (e) {
      this.toast(`This link's level could not be read (${e instanceof Error ? e.message : String(e)}). Here is the default level.`);
      this.toEditor(defaultLevel());
      return;
    }
    const lint = lintLevel(level, this.host.rules);
    if (!lint.ok) {
      this.toast('This level has errors, so it opened in the editor.');
      this.toEditor(level);
    } else if (edit) {
      this.toEditor(level);
    } else {
      this.play(level, false);
    }
  }

  /** The editor: on `level` with a fresh history, or on what was played. */
  toEditor(level?: Level): void {
    const editor = this.editor;
    if (!editor) return;
    this.stopGame();
    this.mode = 'edit';
    if (level) editor.load(level);
    else if (this.playing && !this.playFromEditor) editor.load(this.playing);
    this.playBar.hidden = true;
    this.gameEl.hidden = true;
    editor.show(true);
    this.writeHash(editor.level, true);
  }

  /** Play a level (it passed the lint). */
  play(level: Level, fromEditor: boolean): void {
    const rules = this.host.rules;
    if (!rules) return;
    const lint = lintLevel(level, rules);
    if (!lint.ok || !lint.data) {
      this.toast(lint.issues.find((i) => i.severity === 'error')?.message ?? 'the level has errors');
      return;
    }
    this.playing = level;
    this.playFromEditor = fromEditor;
    this.mode = 'play';
    this.shareBox.hidden = true;
    this.editor?.show(false);
    this.gameEl.hidden = false;
    this.playBar.hidden = false;
    const kb = this.game.input.keyboard;
    if (kb) kb.enabled = true;
    this.game.loop.wake();
    const label = (level.name || 'LEVEL').slice(0, 16);
    const set = levelCourseSet(lint.data, label);
    this.host.set = set;
    this.startHole();
    this.writeHash(level, false);
    // the par for the Result card, when the solver has it
    void this.parSolver?.solve(lint.json).then((r) => {
      if (r?.ok && this.host.set === set) set.holes[0].par = r.par;
    });
  }

  /** Play the level in play again, from the tee. */
  retry(): void {
    if (this.playing) this.play(this.playing, this.playFromEditor);
  }

  private startHole(): void {
    const sm = this.game.scene;
    const world = this.host.world;
    const set = this.host.set!;
    resume(world);
    for (const k of [SceneKeys.Hole, SceneKeys.Result, SceneKeys.Menu]) if (this.running(k)) sm.stop(k);
    world.get(Save)!.member = -1; // the levels keep no save
    startCourse(world, this.host.rules!, set.holes.map((h) => h.data), -1);
    sm.start(SceneKeys.Hole, { host: this.host });
  }

  /** The game to its idle state: no hole, the menu scene up, the loop asleep, no keys. */
  private stopGame(): void {
    const sm = this.game.scene;
    const world = this.host.world;
    resume(world);
    for (const k of [SceneKeys.Hole, SceneKeys.Hud, SceneKeys.Result]) if (this.running(k)) sm.stop(k);
    if (world.get(HoleFlow)!.phase !== 'Idle') endGame(world);
    if (!this.running(SceneKeys.Menu)) sm.start(SceneKeys.Menu, { host: this.host });
    this.host.audio?.stopAll();
    const kb = this.game.input.keyboard;
    if (kb) kb.enabled = false;
    this.game.loop.sleep();
  }

  private running(key: string): boolean {
    const sm = this.game.scene;
    return sm.isActive(key) || sm.isPaused(key) || sm.isSleeping(key);
  }

  /** Keep the level in the URL (soon: the edits come in bursts). */
  private writeHash(level: Level, edit: boolean): void {
    clearTimeout(this.hashTimer);
    this.hashTimer = window.setTimeout(() => {
      void encodeLevel(level).then((payload) => {
        const hash = formatHash(payload, edit);
        if (hash === window.location.hash) return;
        window.history.replaceState(null, '', hash);
        this.lastHash = window.location.hash;
      });
    }, edit ? HASH_DELAY_MS : 0);
  }

  /** The link that plays a level. */
  async shareUrl(level: Level): Promise<string> {
    const payload = await encodeLevel(level);
    return `${window.location.origin}${window.location.pathname}${formatHash(payload, false)}`;
  }

  private async share(level: Level): Promise<void> {
    const url = await this.shareUrl(level);
    this.shareInput.value = url;
    this.shareNote.textContent = '';
    this.shareBox.hidden = false;
    this.shareInput.focus();
    try {
      await navigator.clipboard.writeText(url);
      this.shareNote.textContent = `Copied (${url.length} characters).`;
    } catch {
      this.shareNote.textContent = 'Copy it from the box above.';
    }
  }

  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true;
    }, 6000);
  }

  private barButton(label: string, title: string, onClick: () => void): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.tabIndex = -1;
    // keep the focus off the button, so Space and Enter stay the game's
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      b.blur();
      onClick();
    });
    this.playBar.appendChild(b);
  }

  /** ?debug: window.__level, for the e2e test and the console. */
  private exposeDebug(): void {
    const editor = this.editor!;
    (window as unknown as { __level?: unknown }).__level = {
      mode: () => this.mode,
      json: () => levelJson(this.mode === 'play' && this.playing ? this.playing : editor.level),
      lint: () => editor.lint?.issues ?? [],
      par: () => editor.parState(),
      selection: () => [...editor.selection],
      shareUrl: () => this.shareUrl(this.mode === 'play' && this.playing ? this.playing : editor.level),
      cellPoint: (x: number, y: number) => editor.cellPoint(x, y),
    };
  }
}
