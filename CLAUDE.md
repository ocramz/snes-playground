# snes-playground

## Repo Layout

```
docs/           long-form findings: memory maps, data formats, subsystems
notes/          working scratch, per-session, unpolished, may be wrong
tools/          analysis scripts
web/            the Phaser 4 + Vite demo of one hole (docs/web-demo.md)
engine/         the Koota + Phaser 4 reimplementation (docs/engine.md); random.html
                plays seeded random holes (src/core/gen)
plans/          design plans for work in progress
symbols.tsv     machine-readable symbol/label table
Makefile        `make` builds the web demo end to end; `make engine-*` the engine;
                clean tiers (make help, docs/tooling.md)
build/          all derived output — GITIGNORED (the demo's assets: build/web/;
                the engine's: build/engine/)
```

`docs/` is for things believed true. `notes/` is for things being worked out;
mark uncertain claims "unconfirmed" and promote them to `docs/` once verified.

## Formats

- [docs/tooling.md](docs/tooling.md) Python tooling we developed to disassemble,
  and commands for common tasks
- [docs/hardware-gotchas.md](docs/hardware-gotchas.md) Facts about the original
  game chip that are easy to get wrong or misleading
- [docs/rom-structure.md](docs/rom-structure.md) What we know about ROM structure,
  address format etc.
- [docs/compression.md](docs/compression.md) — the HAL LZ format that every
  compressed asset uses, and the two decompressor entry points.
- [docs/audio.md](docs/audio.md) — N-SPC driver upload, BRR samples,
  33 songs and 125 effects, how the standalone `.spc` files are built, the
  sequencer's timing, how the WAV renderer was validated, and the stems
  (per voice and per sample, wet and dry).
- [docs/graphics.md](docs/graphics.md) — tiles, tilemaps, palettes, the
  metasprite/OAM pipeline, the VRAM transfer queue, and how sprite sheets
  are rendered.
- [docs/animation.md](docs/animation.md) — the animation bytecode of the
  script-driven objects, and the thread objects: 234 coroutine object types,
  their slot fields, and the inline-operand helpers they call.
- [docs/courses.md](docs/courses.md) — the eleven bank `$88` course tables,
  including the row directory that unpacks the two background tilemaps.
- [docs/terrain.md](docs/terrain.md) — the playfield: elevation, the 28
  terrain shapes, the surface equation, and how gaps work.
- [docs/tiles.md](docs/tiles.md) — the special-tile layer: the dispatch
  tables, friction overrides, boost panels, kickers, arrow, snap and warp
  panels, and hazards.
- [docs/scenes.md](docs/scenes.md) — the 20 screen setup blocks, the four
  loader jump tables, and which graphics and palette each screen loads.
- [docs/text.md](docs/text.md) — the font-tile encoding, the control codes,
  and where the strings are.
- [docs/physics.md](docs/physics.md) — the ball's state and one physics
  frame (friction, slope acceleration, the bounce as a reflection in the
  surface normal, walls and steps, the shot's power and spin), the game's
  enemy list and how the last enemy becomes the cup, the hit and holing
  rules, King Dedede, the screen projection, and the driver that plays the
  whole game, the extra game and a 2-player course.
- [docs/emulation.md](docs/emulation.md) — the headless stepper: what is
  emulated, how it was validated against the static facts, input scripts,
  pokes, and which screens they reach.
- [docs/flow.md](docs/flow.md) — the 1-player turn and hole as the game
  runs them: the set-up and the aim target, the aim loop and the guide's lag,
  the shot thread's stages and the shot panel's timing, the roll's end, the
  tomato queue, lives and strokes, running out of tomatoes, the lost ball and
  the hole-out's timeline.
- [docs/engine.md](docs/engine.md) — the Koota × Phaser 4 reimplementation in
  `engine/`: how to run and test it, the dependency rules, the event model,
  the frame (every system with the routine it ports), the traits, the hole
  flow, the bridge and views, the event and asset tables, the random holes
  (the generator, the physics-checked solver, the styled terrain drawn from
  the course art's exemplar patches), the deviations from the game, and what
  is unported, deferred or unconfirmed.
- [docs/web-demo.md](docs/web-demo.md) — the browser demo of course 1 hole 1:
  how to export the assets and run it, the TypeScript port of the ball physics
  and how it was checked frame by frame against the game, what was measured
  for it, and what is approximated; also the hand-gesture variant
  (`web/hands.html`: aim and putt with two hands in front of the webcam).

## Workflow

- Read-only by default. The ROM is never an output path.
- Every derived artifact — dumps, decompressed blobs, rendered graphics,
  disassembly listings — goes in `build/`, which is gitignored. 
- Record where a fact came from. "Verified with `xxd` at `0x7FD5`" beats an
  unattributed assertion; a later session cannot otherwise tell measurements
  from guesses.
- When a tool's output contradicts a note in `docs/`, re-measure before
  believing either. The vector table above was recorded wrongly on first pass
  precisely because it was read at the wrong alignment.

