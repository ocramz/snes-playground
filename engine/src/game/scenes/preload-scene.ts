import Phaser from 'phaser';
import { Rules, RulesUrl } from '../assets/keys';

/**
 * Queues the shared assets and, once the core actions exist, dispatches
 * `loadRules` and `startCourse`. For now it loads only rules/tables.json
 * (which is also how `npm run dev` behaves usefully before `make
 * engine-assets` has run) and reports what it found.
 */
export class PreloadScene extends Phaser.Scene {
  constructor() {
    super('preload');
  }

  preload(): void {
    this.load.json(Rules.tables, RulesUrl.tables);
  }

  create(): void {
    const haveTables = this.cache.json.has(Rules.tables);
    const lines = [
      'engine scaffold',
      '',
      `rules/tables.json: ${haveTables ? 'loaded' : 'MISSING — run: make build/engine/rules/tables.json'}`,
      'assets: run: make engine-assets',
      '',
      'The game scenes land with the bridge (implementation step 7).',
    ];
    this.add
      .text(8, 8, lines.join('\n'), { fontFamily: 'monospace', fontSize: '12px', color: '#dddddd' })
      .setResolution(2);
  }
}
