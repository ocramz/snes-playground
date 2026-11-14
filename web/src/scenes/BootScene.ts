import Phaser from 'phaser';
import { Rom, type CourseJson, type TablesJson } from '../sim/tables';
import { registerAtlas, registerFrames, UI, type AtlasJson } from '../render/atlas';
import type { UiJson } from '../render/shotpanel';
import { registerFont } from '../render/text';

interface LayersJson { files: Record<string, number[]>; backColour: number[]; outline?: { stepFrames: number; cycle: number[][] } }

/** Loads everything the exporter wrote (build/web, served at /). */
export class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload(): void {
    const bar = this.add.rectangle(128, 112, 0, 4, 0xffffff).setOrigin(0, 0.5);
    bar.x = 64;
    this.load.on('progress', (p: number) => { bar.width = 128 * p; });
    this.load.json('tables', 'tables.json');
    this.load.json('course', 'course.json');
    this.load.json('atlas', 'sprites.json');
    this.load.json('layers', 'layers.json');
    this.load.json('ui', 'ui.json');
    this.load.image(UI, 'ui.png');
    this.load.image('sprites', 'sprites.png');
    this.load.image('font', 'font.png');
    this.load.image('hud_panel', 'hud_panel.png');
    this.load.image('hud_tomato', 'hud_tomato.png');
    this.load.on('filecomplete-json-layers', (_k: string, _t: string, data: LayersJson) => {
      for (const f of Object.keys(data.files)) this.load.image(f.replace('.png', ''), f);
    });
  }

  create(): void {
    const tables = this.cache.json.get('tables') as TablesJson;
    const course = this.cache.json.get('course') as CourseJson;
    const atlas = this.cache.json.get('atlas') as AtlasJson;
    const layers = this.cache.json.get('layers') as LayersJson;
    registerAtlas(this, atlas);
    const ui = this.cache.json.get('ui') as UiJson;
    registerFrames(this, UI, ui.frames);
    this.registry.set('ui', ui);
    registerFont(this);
    this.registry.set('rom', new Rom(tables));
    this.registry.set('course', course);
    this.registry.set('atlas', atlas);
    this.registry.set('layers', layers);
    this.scene.start('Title');
  }
}
