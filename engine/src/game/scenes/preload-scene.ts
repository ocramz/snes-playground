/**
 * Queues everything under build/engine (reference §7; caches are global in
 * Phaser): the rules, then — if `make engine-assets` has run — the atlases,
 * the panel, the score panel, the font, the audio, the cutscenes and the
 * eight course-1 holes (course.json, layers.json and the bitmaps it lists).
 * `create` turns the atlases into textures and global animations, builds the
 * font and the course sets, and goes to the menu. Without the rules it shows
 * what to build; without the assets only the test courses are offered.
 */
import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import {
  AssetUrl, Json, ROM_HOLES, Rules, RulesUrl, Tex, holeJsonKey, holeTexKey, holeUrl, sfxKey, songKey, assetUrl,
} from '../assets/keys';
import { addAtlasClips, addAtlasFrames } from '../assets/atlas';
import type { AtlasJson, AudioJson, CutscenesJson, HudJson, LayersJson, UiJson } from '../assets/schema';
import { romCourseSet, testCourseSet } from '../assets/course-sets';
import { RomRules, type TablesJson } from '../../core/rules';
import type { CourseJson } from '../../core/course-data';
import { buildFont } from '../features/text/font';
import { AudioPlayer } from '../features/audio/audio-player';
import type { Host, SceneData } from '../host';
import type { TerrainStyle, TerrainStyleJson } from '../features/layers/styled';

const other = (url: string): string => url.replace(/\.ogg$/, '.mp3');

export class PreloadScene extends Phaser.Scene {
  private host!: Host;

  constructor() {
    super(SceneKeys.Preload);
  }

  init(data: SceneData): void {
    this.host = data.host;
  }

  preload(): void {
    const label = this.add.text(8, 8, 'loading', { fontFamily: 'monospace', fontSize: '8px', color: '#aaaaaa' }).setResolution(2);
    this.load.on(Phaser.Loader.Events.PROGRESS, (v: number) => label.setText(`loading ${Math.round(v * 100)}%`));
    this.load.json(Rules.tables, RulesUrl.tables);
    this.load.json(Json.manifest, AssetUrl.manifest);
    this.load.once(`${Phaser.Loader.Events.FILE_KEY_COMPLETE}json-${Json.manifest}`, (_k: string, _t: string, data: { files?: string[] }) => {
      this.queueAssets(new Set(data?.files ?? []));
    });
  }

  private queueAssets(files: Set<string>): void {
    const load = this.load;
    if (files.has('sprites.json')) {
      load.json(Json.atlas, AssetUrl.atlas);
      load.image(Tex.atlas, AssetUrl.atlasImage);
    }
    if (files.has('objects.json')) {
      load.json(Json.objects, AssetUrl.objects);
      load.image(Tex.objects, AssetUrl.objectsImage);
    }
    if (files.has('ui.json')) {
      load.json(Json.ui, AssetUrl.ui);
      load.image(Tex.ui, AssetUrl.uiImage);
    }
    if (files.has('hud.json')) load.json(Json.hud, AssetUrl.hud);
    if (files.has('hud_panel.png')) load.image(Tex.hudPanel, AssetUrl.hudPanel);
    if (files.has('hud_tomato.png')) load.image(Tex.hudTomato, AssetUrl.hudTomato);
    if (files.has('font.png')) load.image(Tex.font, AssetUrl.font);
    if (files.has('cutscenes.json')) load.json(Json.cutscenes, AssetUrl.cutscenes);
    if (files.has('terrain_style.json') && files.has('terrain_style.png')) {
      load.json(Json.terrainStyle, AssetUrl.terrainStyle);
      load.image(Tex.terrainStyle, AssetUrl.terrainStyleImage);
    }
    if (files.has('audio.json')) {
      load.json(Json.audio, AssetUrl.audio);
      load.once(`${Phaser.Loader.Events.FILE_KEY_COMPLETE}json-${Json.audio}`, (_k: string, _t: string, a: AudioJson) => {
        for (const [n, entry] of Object.entries(a.songs)) load.audio(songKey(Number(n)), [assetUrl(entry.file), assetUrl(other(entry.file))]);
        for (const [id, file] of Object.entries(a.sfx)) load.audio(sfxKey(Number(id)), [assetUrl(file), assetUrl(other(file))]);
      });
    }
    if (files.has('holes')) {
      for (let i = 0; i < ROM_HOLES; i++) {
        load.json(holeJsonKey(i, 'course'), holeUrl(i, 'course.json'));
        const key = holeJsonKey(i, 'layers');
        load.json(key, holeUrl(i, 'layers.json'));
        load.once(`${Phaser.Loader.Events.FILE_KEY_COMPLETE}json-${key}`, (_k: string, _t: string, l: LayersJson) => {
          for (const file of Object.keys(l.files)) load.image(holeTexKey(i, file), holeUrl(i, file));
        });
      }
    }
  }

  /** The style atlas' pixels, read back once for the software rasteriser (features/layers/styled.ts). */
  private terrainStyle(json: TerrainStyleJson | null): TerrainStyle | null {
    if (!json || !this.textures.exists(Tex.terrainStyle)) return null;
    const img = this.textures.get(Tex.terrainStyle).getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, img.width, img.height).data;
    return { json, atlas: { data, width: img.width, height: img.height } };
  }

  create(): void {
    const json = <T>(key: string): T | null => (this.cache.json.exists(key) ? (this.cache.json.get(key) as T) : null);
    const tables = json<TablesJson>(Rules.tables);
    if (!tables) {
      this.add.text(8, 8, [
        'engine', '',
        'rules/tables.json is missing:', '  make build/engine/rules/tables.json',
        'assets (optional): make engine-assets',
      ].join('\n'), { fontFamily: 'monospace', fontSize: '8px', color: '#dddddd' }).setResolution(2);
      return;
    }
    const host = this.host;
    host.rules = new RomRules(tables);
    host.assets = {
      atlas: this.textures.exists(Tex.atlas) ? json<AtlasJson>(Json.atlas) : null,
      objects: this.textures.exists(Tex.objects) ? json<AtlasJson>(Json.objects) : null,
      ui: this.textures.exists(Tex.ui) ? json<UiJson>(Json.ui) : null,
      hud: json<HudJson>(Json.hud),
      audio: json<AudioJson>(Json.audio),
      cutscenes: json<CutscenesJson>(Json.cutscenes),
      terrainStyle: this.terrainStyle(json<TerrainStyleJson>(Json.terrainStyle)),
    };
    if (host.assets.atlas) {
      addAtlasFrames(this.textures, Tex.atlas, host.assets.atlas);
      addAtlasClips(this.anims, Tex.atlas, host.assets.atlas);
    }
    if (host.assets.objects) addAtlasFrames(this.textures, Tex.objects, host.assets.objects);
    if (host.assets.ui) addAtlasFrames(this.textures, Tex.ui, { ...host.assets.ui, clips: {} });
    buildFont(this);
    host.sets = [];
    const holes: Array<{ course: CourseJson; layers: LayersJson | null }> = [];
    for (let i = 0; i < ROM_HOLES; i++) {
      const course = json<CourseJson>(holeJsonKey(i, 'course'));
      if (course) holes.push({ course, layers: json<LayersJson>(holeJsonKey(i, 'layers')) });
    }
    // the ROM course needs its pictures: Kirby and the course bitmaps
    if (holes.length === ROM_HOLES && host.assets.atlas) host.sets.push(romCourseSet(holes));
    host.sets.push(testCourseSet(host.rules));
    host.audio = new AudioPlayer(this.game, host.assets.audio);
    this.scene.start(SceneKeys.Menu, { host });
  }
}
