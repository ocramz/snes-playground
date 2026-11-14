# Koota × Phaser 4 — Reference Game Engine Architecture

> A high-level blueprint for games where **Koota** owns game state and rules (ECS) and **Phaser 4** owns the platform: rendering, input devices, assets, audio, scene orchestration and, optionally, physics.

**Basis.** This document synthesises the official agent skills shipped with each library:

- `pmndrs/koota` → `skills/koota` (SKILL.md + references: architecture, runtime, queries, relations, react-hooks, react-patterns) — koota 0.6.6
- `phaserjs/phaser` → `skills/*` (28 skills: game-setup-and-config, scenes, events-system, game-object-components, groups-and-containers, physics-arcade, physics-matter, loading-assets, input, time-and-timers, data-manager, v4-new-features, v3-to-v4-migration, …) — phaser 4.2.1

**Legend.** Conventions tagged **[Koota]** or **[Phaser]** come straight from that library's skill (or, in a few places, its README). **[Bridge]** marks a convention this architecture adds to join the two. API names appear only to anchor structure; see each library's skill for details.

---

## Contents

1. [Guiding idea](#1-guiding-idea)
2. [Who owns what](#2-who-owns-what)
3. [Layers and dependency rules](#3-layers-and-dependency-rules)
4. [Directory structure](#4-directory-structure)
5. [Naming conventions](#5-naming-conventions)
6. [The world and its data model](#6-the-world-and-its-data-model)
7. [Scenes as hosts](#7-scenes-as-hosts)
8. [The frame pipeline](#8-the-frame-pipeline)
9. [The bridge: entity ↔ game object](#9-the-bridge-entity--game-object)
10. [Input](#10-input)
11. [Physics: two integration modes](#11-physics-two-integration-modes)
12. [Animation, tweens, timers, audio and FX](#12-animation-tweens-timers-audio-and-fx)
13. [Levels, tilemaps and spawning](#13-levels-tilemaps-and-spawning)
14. [UI and HUD](#14-ui-and-hud)
15. [Lifetimes and cleanup](#15-lifetimes-and-cleanup)
16. [Performance guidelines](#16-performance-guidelines)
17. [Testing and portability](#17-testing-and-portability)
18. [Anti-patterns](#18-anti-patterns)
19. [Phaser 4 specifics to respect](#19-phaser-4-specifics-to-respect)

---

## 1. Guiding idea

Koota's central design principle is **decouple view from logic**: the core runs independently of rendering, the view can be swapped (2D ↔ 3D), and the core can run in a worker or on a server **[Koota]**. Phaser, used conventionally, is the opposite: state lives on GameObjects, scene fields, DataManagers and the registry, and behaviour lives in `Scene.update()` and GameObject subclasses **[Phaser]**.

This architecture resolves the tension with one rule:

> **Koota is the single source of truth for game state. Phaser is the view and the platform. A thin bridge layer is the only code that touches both.**

```
 PHASER (platform)              BRIDGE (systems)              KOOTA (core)
 ─────────────────              ────────────────              ────────────
 Scene.update(time, delta) ──▶  tick-time          ──▶  Time            (singleton)
 Keyboard / pointer / pad  ──▶  capture-input      ──▶  Input           (singleton)
 Arcade / Matter (opt.)    ──▶  readback-physics   ──▶  Position, CollidingWith
                                                           │
                                                           ▼
                                                  core systems  (rules)
                                                  actions       (mutations)
                                                           │
 GameObjects (create/free) ◀──  bind-views         ◀──  Visual, Not(Ref) / Removed(Visual)
 GameObject transforms     ◀──  sync-transforms    ◀──  Position, Rotation
 Anims · FX · SFX · camera ◀──  sync-* / play-*    ◀──  Changed(MoveState), Added(IsDead) …
```

Data flows one way per frame: **Phaser → bridge → core → bridge → Phaser**.

---

## 2. Who owns what

| Concern | Koota offers | Phaser offers | Owner here |
|---|---|---|---|
| Game state | Traits on entities, world singletons | GameObject props, per-object/scene DataManager, `registry` | **Koota** |
| Game rules | Systems (reactive orchestration), actions (discrete mutations) | `Scene.update()`, GameObject subclasses, `Group` `runChildUpdate` | **Koota** |
| Entity graphs | Relations (`ChildOf`, `Contains`, `Targeting`, ordered relations) | Containers (visual transform tree), Groups (sets/pools) | **Koota** (Containers only for cosmetic composites) |
| Frame loop | None built-in — you call systems from a frameloop | `TimeStep` → `SceneManager` → per-scene update/render | **Phaser drives**, Koota schedule runs inside it |
| Time | `Time` singleton trait updated first each frame | `delta` in `update`, per-scene `Clock` | Phaser provides delta → Koota `Time` |
| Rendering | — | Display list, cameras, filters, lighting, GPU layers | **Phaser** |
| Input devices | "Capture into traits" / "run on transition" patterns | Input plugin: keyboard, pointer, touch, gamepad | Phaser captures → Koota traits/actions |
| Assets | — | Loader + global texture/cache managers | **Phaser** |
| Audio | — | Global SoundManager | **Phaser**, triggered by state changes |
| Physics | Write your own systems | Arcade, Matter | **Either** — see §11 |
| Screens / modes | — | Scenes (start, launch, sleep, pause, transition) | **Phaser** |
| Signalling | `onAdd`/`onRemove`/`onChange`, `Added`/`Removed`/`Changed` tracking | EventEmitter on every subsystem | Koota for game events; Phaser events only at the boundary |
| Composition | Entities compose traits **at runtime** | Classes compose mixins **at definition time** | Both, at different layers |

**Watch the vocabulary clash.** Phaser "components" (Transform, Alpha, Tint, Depth, …) are mixins copied onto class prototypes — they describe *how a thing is drawn* **[Phaser]**. Koota traits describe *what a thing is* **[Koota]**. A Phaser `Transform` is not a Koota `Position`; the bridge copies one into the other.

---

## 3. Layers and dependency rules

```
 ┌────────────────────────────────────────────────────────────┐
 │ main.ts           creates the world, then the Phaser.Game  │
 ├────────────────────────────────────────────────────────────┤
 │ game/scenes       compose everything below; own lifecycles │
 ├──────────────────────────────┬─────────────────────────────┤
 │ game/features                │ game/bridge                 │
 │ per-domain views, anims, SFX │ capture / bind / sync /     │
 │                              │ readback systems, view-only │
 │                              │ traits, view registry       │
 ├──────────────────────────────┴─────────────────────────────┤
 │ core              traits · relations · systems · actions   │
 │                   world · schedule      (koota only)       │
 └────────────────────────────────────────────────────────────┘
```

| Layer | May import | Must not import |
|---|---|---|
| `core/` | `koota` | `phaser`, anything in `game/` |
| `game/bridge/` | `core/`, `koota`, `phaser` | `game/scenes/` |
| `game/features/` | core traits (read), core actions (write), `game/bridge/`, `phaser` | core systems |
| `game/scenes/` | everything above | — |

**Mutation rules.**

- **Core systems** mutate traits freely **[Koota]**.
- **The view reads from the world and mutates via actions** **[Koota]**. Features and scenes never `set()` gameplay traits directly.
- **Bridge exceptions** **[Bridge]**: bridge systems may write the input singletons, the view-only traits (`Ref`, `Body`), and — only in physics mode B — physics read-back into `Position`. These are the sanctioned crossings.

---

## 4. Directory structure

Koota prescribes `core/` organised **by role** (traits, systems, actions, world) and a view layer organised **by domain** (`features/`) **[Koota]**. Phaser contributes scenes and assets. Merged:

```
src/
├── core/                         # Pure TypeScript + koota. Never imports phaser.
│   ├── traits/
│   │   ├── time.ts               # Time (world singleton)
│   │   ├── input.ts              # Input intents (world singleton)
│   │   ├── transform.ts          # Position, Velocity, Rotation
│   │   ├── combat.ts             # Health, Damage, Cooldown
│   │   ├── presentation.ts       # Visual { kind }, MoveState, Facing — semantic only
│   │   ├── tags.ts               # IsPlayer, IsEnemy, IsDead, IsPaused …
│   │   ├── relations.ts          # InLevel, ChildOf, Targeting, CollidingWith
│   │   └── index.ts
│   ├── systems/                  # one file per system
│   │   ├── update-player-control.ts
│   │   ├── update-ai.ts
│   │   ├── update-movement.ts
│   │   ├── apply-collisions.ts
│   │   ├── update-cooldowns.ts
│   │   ├── cleanup-dead.ts
│   │   └── index.ts
│   ├── actions/
│   │   ├── level-actions.ts      # startLevel, endLevel
│   │   ├── spawn-actions.ts      # spawnPlayer, spawnEnemy … (your "prefabs")
│   │   ├── combat-actions.ts     # damage, heal, kill
│   │   └── index.ts              # createActions bundle(s)
│   ├── schedule.ts               # ordered list of simulation systems
│   └── world.ts                  # createWorld(Time, Input, …)
│
├── game/                         # Phaser layer (Koota's "view")
│   ├── config.ts                 # Phaser GameConfig
│   ├── scene-keys.ts             # scene key constants
│   ├── scenes/
│   │   ├── boot-scene.ts
│   │   ├── preload-scene.ts
│   │   ├── menu-scene.ts
│   │   ├── level-scene.ts        # the simulation host (see §7)
│   │   └── hud-scene.ts          # parallel overlay
│   ├── bridge/                   # the only place both libraries meet
│   │   ├── traits.ts             # Ref (GameObject), Body (physics body), IsPhysicsDriven
│   │   ├── view-registry.ts      # Map<Entity, GameObject>, pools, view catalog lookup
│   │   ├── tick-time.ts
│   │   ├── capture-input.ts
│   │   ├── bind-views.ts
│   │   ├── sync-transforms.ts
│   │   ├── sync-animations.ts
│   │   ├── play-feedback.ts      # SFX, particles, camera shake on state transitions
│   │   ├── readback-physics.ts   # only in physics mode B
│   │   ├── disposables.ts        # collects unsubscribe/off callbacks per scene
│   │   └── schedule.ts           # ordered list of presentation systems
│   ├── features/                 # by domain: how each kind of entity looks and sounds
│   │   ├── player/   player-view.ts, player-anims.ts
│   │   ├── enemies/  enemy-view.ts, enemy-anims.ts
│   │   ├── projectiles/
│   │   ├── environment/          # tilemap layers, parallax
│   │   ├── hud/
│   │   └── view-catalog.ts       # Visual.kind → {Domain}View factory
│   └── assets/
│       ├── keys.ts               # texture / atlas / audio / anim key constants
│       └── manifest.ts           # what each loading scene queues
├── utils/                        # generic helpers, no koota/phaser specifics
└── main.ts
```

**When to go monorepo.** If the core must also run headless (dedicated server, bot, replay validator, worker), adopt Koota's monorepo split **[Koota]**:

```
packages/core     → @game/core   (traits, systems, actions, world)
apps/web          → Phaser client (imports @game/core)
apps/server       → authoritative sim (imports @game/core only)
```

---

## 5. Naming conventions

| Artefact | Convention | Example | Origin |
|---|---|---|---|
| Data trait | Noun, PascalCase | `Position`, `Health` | **[Koota]** |
| Tag | `Is` prefix | `IsPlayer`, `IsDead` | **[Koota]** |
| Relation | Prepositional | `ChildOf`, `InLevel`, `CollidingWith` | **[Koota]** |
| System | Verb-first function, `world: World` first param, one per file | `updateMovement(world)` in `update-movement.ts` | **[Koota]** |
| System file | `update-{thing}.ts` or `{verb}-{thing}.ts` | `cleanup-dead.ts` | **[Koota]** |
| Actions | `createActions` bundles grouped by domain | `combatActions`, `spawnActions` | **[Koota]** |
| Tracking modifiers | Created once at module scope, one instance per consumer | `const Added = createAdded()` | **[Koota]** |
| Hot queries | `createQuery` at module scope | `const movers = createQuery(Position, Velocity)` | **[Koota]** |
| Scene class / key | `{Name}Scene`, key passed to `super()` | `LevelScene`, `super(SceneKeys.Level)` | **[Phaser]** |
| Scene keys | Constants module, not string literals | `SceneKeys.Hud` | **[Bridge]** |
| Event names | Phaser event constants over raw strings | `Phaser.Scenes.Events.SHUTDOWN` | **[Phaser]** |
| Asset keys | Constants module; loader prefixes if packs are namespaced | `Textures.Goblin` | **[Bridge]** / **[Phaser]** |
| Bridge systems | `tick-*`, `capture-*`, `bind-*`, `sync-*`, `play-*`, `readback-*` | `sync-transforms.ts` | **[Bridge]** |
| View factories | `{Domain}View` creates the Phaser object(s) for one entity | `EnemyView` | Adapted from Koota's `{Domain}Renderer` / `{Domain}View` **[Koota]** |
| View-only traits | Live in `game/bridge/traits.ts` | `Ref`, `Body` | **[Bridge]** |

Koota's skill also says: follow the user's or codebase's existing conventions over these examples **[Koota]**.

---

## 6. The world and its data model

### World

- **One world per running game** — "typically you only need one world" **[Koota]**. Create it in `core/world.ts` and pass global singletons to `createWorld` **[Koota]**.
- The world **outlives Phaser scenes**. Scenes come and go; the world is the cross-scene state store. This replaces most uses of Phaser's `registry` and `game.events` bus **[Bridge]**.

```ts
// core/world.ts
import { createWorld } from 'koota'
import { Time, Input } from './traits'

export const world = createWorld(Time, Input)
```

### Traits

| Kind | Use for | Examples |
|---|---|---|
| SoA schema `trait({ … })` | Primitive gameplay data | `Position`, `Velocity`, `Health`, `Cooldown` |
| AoS callback `trait(() => …)` | Complex objects / external instances | `CollisionGrid`, bridge-only `Ref`, `Body` |
| Tag `trait()` | Flags and modes | `IsPlayer`, `IsDead`, world-level `IsPaused` |

Rules carried over from Koota:

- **Prefer many entities over array traits** — queryable, composable, extensible **[Koota]**.
- **Prefer traits + actions over classes**; classes only where an external library demands them **[Koota]**. Phaser scenes and GameObjects are exactly that case — so classes stay in `game/`, never in `core/`.

Rules added for Phaser **[Bridge]**:

- **Core stores semantics, not assets.** `Visual { kind: 'goblin' }`, `MoveState { state: 'run' }`, `Facing { dir }` — never texture keys, animation keys or GameObject references. The view catalog maps `kind` → texture, animations, depth band, physics shape. This keeps the 2D ↔ 3D swap possible.
- **Gameplay time is data.** Cooldowns, spawn timers and buff durations are traits decremented by systems from `Time.delta` — not Phaser timers (see §12).

```ts
// core/traits (abridged)
export const Position   = trait({ x: 0, y: 0 })
export const Velocity   = trait({ x: 0, y: 0 })
export const MoveIntent = trait({ x: 0, y: 0 })
export const Health     = trait({ value: 100, max: 100 })
export const Visual     = trait({ kind: '' })        // semantic: 'player', 'goblin', 'arrow'
export const MoveState  = trait({ state: 'idle' as 'idle' | 'run' | 'hurt' })

export const LevelInfo  = trait({ id: '' })

export const IsPlayer = trait()
export const IsEnemy  = trait()
export const IsLevel  = trait()
export const IsDead   = trait()
export const IsPaused = trait()                       // added to the world, not to an entity

export const InLevel       = relation({ autoDestroy: 'orphan' })
export const CollidingWith = relation()
```

### Relations

Relations replace every "store a reference to another object" habit **[Koota]**:

| Relation | Options | Purpose |
|---|---|---|
| `InLevel` | `autoDestroy: 'orphan'` | Every session entity points at a **level root entity**. Destroying the level destroys everything in it — one-line teardown on scene shutdown. **[Bridge]** pattern built on **[Koota]** semantics |
| `ChildOf` | `autoDestroy: 'orphan'` | Attachments (weapon on hand, turret on tank). Core computes world positions; Phaser need not nest Containers |
| `Targeting` | `exclusive: true` | AI target selection |
| `Contains` | `store: { amount }` | Inventories, loot tables |
| `CollidingWith` | none | Per-frame contact facts produced by physics, consumed and cleared by `apply-collisions` |

Koota's own anti-patterns apply: no `parent` fields in traits, no child arrays on parents, always `autoDestroy` on hierarchies, wildcard `('*')` to query "any target" **[Koota]**.

### Actions

Actions are the **write API of the core**: discrete, synchronous, reusable from systems, scenes, UI handlers, tests **[Koota]**. Spawn actions double as your prefab system.

```ts
// core/actions/index.ts (abridged)
export const actions = createActions((world) => ({
  startLevel: (id: string) => world.spawn(IsLevel, LevelInfo({ id })),
  spawnEnemy: (level: Entity, x: number, y: number) =>
    world.spawn(Position({ x, y }), Velocity, MoveIntent, Health({ value: 50 }),
                Visual({ kind: 'goblin' }), IsEnemy, InLevel(level)),
  damage: (target: Entity, amount: number) => { /* clamp, add IsDead at 0 */ },
  pause:  () => world.add(IsPaused),
  resume: () => world.remove(IsPaused),
}))

// Outside React (i.e. in Phaser scenes and bridge code): bind to the world
const { spawnEnemy } = actions(world)          // [Koota] "In vanilla/systems: actions(world)"
```

**Litmus test** for action vs system: a direct mutation callable from many places is an action; "when X happens, do Y" is a system **[Koota]**.

---

## 7. Scenes as hosts

Phaser scenes are the **modes and screens** of the game. In this architecture they are *hosts*: they own Phaser resources and lifecycles, and they run schedules — but they hold no gameplay state.

### Scene roles

| Scene | Role | Runs core schedule? |
|---|---|---|
| `BootScene` | Minimal config; scene `pack` loads loading-bar assets before `preload` **[Phaser]** | No |
| `PreloadScene` | Queues all shared assets (caches are global **[Phaser]**); registers global animations (AnimationManager is global **[Phaser]**) | No |
| `MenuScene` | Menus; calls actions (`newGame`, `loadSave`) | No |
| `LevelScene` | **Simulation host**. Runs the full frame pipeline (§8); owns world-space views | **Yes — the only one** |
| `HudScene` | Launched in parallel on top; reads the world and draws UI | No |
| `PauseScene` (opt.) | Overlay; calls `pause`/`resume` actions | No |

**Why exactly one simulation host.** Phaser updates scenes in **reverse** order (top scene first) and renders in **forward** order **[Phaser]**. Running systems from several scenes makes system order depend on scene stacking. One host makes the order explicit.

### Lifecycle mapping

| Phaser hook | Responsibility here |
|---|---|
| `constructor` | Key and static scene config only. Runs once — never put resettable state here **[Phaser]** |
| `init(data)` | Reset scene-local fields every start/restart **[Phaser]**; read level id (and the world, if injected) |
| `preload()` | Queue scene-specific assets |
| `create()` | Spawn via actions (Koota's "Startup" role **[Koota]**); build view registry and input bindings; launch HUD; register `SHUTDOWN` cleanup |
| `update(time, delta)` | Run the frame pipeline (Koota's "Frameloop" role **[Koota]**) |
| `SHUTDOWN` event | Dispose subscriptions, release views, destroy level entity (§15) |
| `DESTROY` event | Final cleanup only |

```ts
// game/scenes/level-scene.ts (skeleton)
export class LevelScene extends Phaser.Scene {
  private levelId!: string
  private level!: Entity
  private views!: ViewRegistry
  private controls!: Controls
  private disposables!: Disposables

  constructor() { super(SceneKeys.Level) }

  init(data: { levelId: string }) {
    this.levelId = data.levelId
    this.disposables = new Disposables()
  }

  create() {
    this.level = actions(world).startLevel(this.levelId)
    spawnFromTilemap(this, world, this.level)                 // §13
    this.views = new ViewRegistry(this, viewCatalog)          // §9
    this.controls = createControls(this.input)                // §10
    this.disposables.add(bindDiscreteInput(this, world))
    this.scene.launch(SceneKeys.Hud)

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.disposables.dispose()   // world.on* unsubscribes + Phaser off()
      this.views.releaseAll()      // removes Ref/Body traits, frees GameObjects
      this.level.destroy()         // cascades through InLevel
    })
  }

  update(_time: number, deltaMs: number) {
    tickTime(world, deltaMs)
    captureInput(world, this.controls)
    runSimulation(world)
    runPresentation(world, this.views)
  }
}
```

### Getting the world into scenes

- **Default:** import the module singleton from `core/world.ts` — Koota's documented setup **[Koota]**.
- **Multiple worlds** (tests, split-screen, replays): pass it through scene data — `scene.start(key, { world })` — and read it in `init(data)` **[Phaser]**.

### Scene gotchas that matter for ECS

- Scene operations (`start`, `stop`, `launch`, …) are **queued to the next frame** **[Phaser]**. Don't expect the target scene's views to exist in the same frame; the bind system handles late binding (§9).
- `start()` **shuts down** the caller; `switch()` **sleeps** it; `launch()`/`run()` run in parallel **[Phaser]**.
- **Paused scenes still render**; sleeping scenes neither update nor render but **keep their listeners alive** **[Phaser]**.

---

## 8. The frame pipeline

Phaser owns the loop. Per scene, a frame runs `preupdate` → `update` event → `Scene.update()` → `postupdate` → `prerender` → `render` **[Phaser]**. By default Arcade physics steps on the scene's `update` event, i.e. *before* `Scene.update()` runs, and Matter auto-steps every game step **[Phaser]**.

The Koota schedule runs inside the simulation host's `update()`:

```
LevelScene.update(time, deltaMs)
│
├─ 1. tick-time         Time ← Phaser delta (ms → s, clamped to 0.1 s)        bridge
├─ 2. capture-input     Input ← keyboard / pointer / gamepad state            bridge
├─ 3. simulation        core/schedule.ts  (skipped while world has IsPaused)  core
│     updatePlayerControl → updateAI → updateMovement →
│     applyCollisions → updateCooldowns → cleanupDead
├─ 4. physics (mode B)  step Phaser physics → readback-physics                bridge
└─ 5. presentation      game/bridge/schedule.ts                               bridge
      bindViews → syncTransforms → syncAnimations → playFeedback
then Phaser renders every visible scene in forward order (HUD last, on top)
```

**Time.** Koota's reference `updateTime` reads `performance.now()`, converts to seconds and caps delta at 0.1 s **[Koota]**. With Phaser, the loop already provides a (smoothed) `delta` in ms **[Phaser]**, so `tick-time` feeds that into the `Time` singleton instead of sampling the clock itself **[Bridge]**:

```ts
// game/bridge/tick-time.ts
export function tickTime(world: World, deltaMs: number) {
  const delta = Math.min(deltaMs / 1000, 0.1)
  world.set(Time, (prev) => ({ delta, elapsed: prev.elapsed + delta }))
}
```

**Schedules are data.** Koota insists on small, single-purpose, independently toggleable systems **[Koota]**. Make each schedule an ordered array so features can be flagged off and systems disabled when debugging:

```ts
// core/schedule.ts
export const simulation = [
  updatePlayerControl, updateAI, updateMovement,
  applyCollisions, updateCooldowns, cleanupDead,
]

export function runSimulation(world: World) {
  if (world.has(IsPaused)) return
  for (const system of simulation) system(world)
}
```

**Fixed step (optional).** For deterministic simulation or netcode, accumulate `delta` in `tick-time` and run `simulation` N times per frame at a fixed `Time.delta`; run `presentation` once. (Phaser Arcade is fixed-step by default at 60 Hz **[Phaser]**; in mode B, align the two rates.)

---

## 9. The bridge: entity ↔ game object

This section adapts Koota's **view-sync** pattern — `Ref` trait + `handleInit` + sync system **[Koota]** — from React/DOM/R3F to Phaser.

### The rule

> Koota: "React controls when a view element connects to an entity. Systems only query and mutate; they never add or remove view refs." **[Koota]**

With Phaser there is no React, so the controlling party is the **bind-views** bridge system. Only it adds or removes `Ref`; core systems never know `Ref` exists **[Bridge]**.

### The pieces

| Piece | What it is | Lives in |
|---|---|---|
| `Ref` | AoS trait holding the entity's Phaser GameObject | `game/bridge/traits.ts` |
| Back-link | `gameObject.setData('entity', entity)` — Phaser's per-object DataManager **[Phaser]**; entities are packed numbers, safe to store **[Koota]** | set by bind-views |
| View registry | Per-scene `Map<Entity, GameObject>` + pools; needed for teardown because a destroyed entity's traits can't be relied on | `game/bridge/view-registry.ts` |
| View catalog | `Visual.kind` → `{Domain}View` factory | `game/features/view-catalog.ts` |
| `{Domain}View` | Creates the Phaser object(s) for one entity: texture, origin, depth, physics shape, filters | `game/features/<domain>/` |

### Binding strategy

```ts
// game/bridge/bind-views.ts
const Removed = createRemoved()
const unbound = createQuery(Visual, Position, Not(Ref))

export function bindViews(world: World, views: ViewRegistry) {
  for (const entity of world.query(unbound)) {
    const go = views.create(entity)          // catalog lookup by Visual.kind; may come from a pool
    go.setData('entity', entity)
    entity.add(Ref(go))
  }
  for (const entity of world.query(Removed(Visual))) {
    views.release(entity)                    // destroy or return to pool; remove Ref if still alive
  }
}
```

- `Not(Ref)` makes binding **self-healing**: anything that should have a view and doesn't gets one — on first frame, after a scene restart, or when a scene launched late.
- `Removed(...)` includes destroyed entities **[Koota]**; the registry supplies the GameObject because the entity's data is gone.
- Alternative: `world.onQueryAdd` / `onQueryRemove` for immediate binding **[Koota]**. Prefer the frame-loop version so view creation happens at a known point in the pipeline.

### Transform authority

Koota's Three.js interop guidance offers two models **[Koota]**; they map directly onto Phaser:

| Model | Who owns the transform | Sync direction | Use when |
|---|---|---|---|
| **Trait-owned** (default) | Koota `Position`/`Rotation` | `sync-transforms`: trait → GameObject every frame | Core does movement (physics mode A) |
| **Ref-owned** | Phaser physics body | `readback-physics`: body → trait every frame | Phaser physics moves things (mode B) |

```ts
// game/bridge/sync-transforms.ts
const synced = createQuery(Position, Ref, Not(IsPhysicsDriven))

export function syncTransforms(world: World) {
  world.query(synced).readEach(([pos, go]) => go.setPosition(pos.x, pos.y))
}
```

### Choosing the Phaser object for an entity

Decided inside each `{Domain}View`, never in core:

| Situation | Phaser construct | Why |
|---|---|---|
| Static visual | `Image` | No per-frame `preUpdate`, not on the update list **[Phaser]** |
| Frame animation | `Sprite` | Only Sprite has AnimationState **[Phaser]** |
| High churn (bullets, pickups, hit sparks) | `Group` pool — `get()` / `killAndHide()` | Entity lifetime in Koota; GameObject recycling in Phaser **[Phaser]** |
| Huge static sets (foliage, debris, star fields) | `SpriteGPULayer` member | Millions of quads in one draw call; populate once; "remove" by alpha/scale 0 **[Phaser]** |
| Cosmetic composite (nameplate + bar) | `Container` inside the view | Transform inheritance — but costs matrix math per child; avoid physics on children **[Phaser]** |
| Render bands (ground / actors / overhead) | `Layer` per band | Render-order bucket without transform cost **[Phaser]** |
| Y-sorting / z-order | `setDepth()` from a trait or from `Position.y` | `depth` wins over display-list order **[Phaser]** |

Koota ordered relations exist for semantic order (UI layers, execution order) **[Koota]**; for plain draw order, Phaser depth is cheaper.

---

## 10. Input

Koota documents two event strategies **[Koota]**; Phaser supplies the devices **[Phaser]**.

| Koota strategy | Phaser source | Bridge behaviour |
|---|---|---|
| **Capture for frameloop** — continuous input stored in traits | Polled keys, cursor keys, pointer state, gamepad axes | `capture-input` writes **intents** into the `Input` singleton each frame |
| **Run on transition** — discrete events execute immediately | `pointerdown` on an interactive GameObject, `keydown-ESC`, drag/drop | Listener resolves the entity via `getData('entity')`, checks `isAlive()`, calls an action |

```ts
// game/bridge/capture-input.ts
export function captureInput(world: World, c: Controls) {
  world.set(Input, {
    moveX: Number(c.right.isDown) - Number(c.left.isDown),
    moveY: Number(c.down.isDown)  - Number(c.up.isDown),
    fire:  c.fire.isDown,
    aimX:  c.pointer.worldX,      // camera-translated by Phaser → core never sees cameras
    aimY:  c.pointer.worldY,
  })
}
```

Conventions:

- **Intents, not keys.** Key mapping lives in the bridge; core sees `moveX`, `fire`, `aimX`. Remapping, gamepads and touch controls never touch core **[Bridge]**.
- **One controller interface.** `updatePlayerControl` copies `Input` → `MoveIntent` on `IsPlayer` entities; AI writes `MoveIntent` on enemies; movement reads `MoveIntent` only. Replays and network peers plug in the same way **[Bridge]**.
- **Scoped input.** For element-scoped input (a minimap, a build grid), store pointer state on a dedicated entity with an identifier tag (`IsMinimap` + `Pointer`, plus `IsHovering`) — Koota's scoped-events pattern **[Koota]**.
- **Cleanup.** Every Phaser `on()` gets a matching `off()` on `SHUTDOWN`, especially listeners on `game.events`, which survive scene restarts **[Phaser]**.

---

## 11. Physics: two integration modes

### Mode A — core physics (default)

Movement, collision and resolution are plain Koota systems. No `physics` block in the Phaser config.

- Best for top-down, shmups, puzzle, grid and many platformers.
- Fully deterministic and headless-testable; runs on a server unchanged.
- Spatial structures (spatial hash, tile collision grid) are AoS singleton traits.

### Mode B — Phaser physics as a backend

Arcade (AABB/circle, tiles, groups) or Matter (rigid bodies, constraints, compound shapes) **[Phaser]**. This is Koota's *ref-owned transform* case: an external library mutates transforms **[Koota]**.

```
core writes intent      bridge pushes intent       Phaser steps         bridge reads back
MoveIntent / Impulse ─▶ apply-physics-intents ─▶  world update  ─▶   readback-physics
                                                  (colliders fire)     body → Position
                                                        │
                                                        ▼
                                          record facts: a.add(CollidingWith(b))
                                                        │
                                          core applyCollisions decides consequences,
                                          then clears CollidingWith('*')
```

Conventions:

- **Body as a view-only trait.** The `{Domain}View` creates the body; bind-views stores it in `Body` and tags `IsPhysicsDriven` **[Bridge]**.
- **Own the step.** Disable automatic stepping — Arcade `customUpdate: true`, Matter `autoUpdate = false` — and step inside pipeline stage 4 **[Phaser]**. Otherwise the physics step is not ordered relative to your systems.
- **Callbacks record, core decides.** Collider/overlap callbacks resolve both entities and add a `CollidingWith` relation. Damage, pickups and scoring stay in core systems. No game rules inside physics callbacks **[Bridge]**.
- **Collision categories from semantics.** Views derive categories/masks from tags (`IsEnemy`, `IsProjectile`). Arcade allows 32 categories **[Phaser]**.
- **Static bodies need a refresh** after transform changes **[Phaser]** — another reason static level geometry stays out of per-frame sync.

| | Mode A (core) | Mode B (Phaser backend) |
|---|---|---|
| Source of truth for position | Koota trait | Phaser body (mirrored into trait) |
| Determinism / server reuse | Yes | Client-only |
| Tile collision, slopes, constraints | Build yourself | Built in |
| Sync systems | `sync-transforms` | `apply-physics-intents`, `readback-physics` |

---

## 12. Animation, tweens, timers, audio and FX

**Principle:** Phaser's time-based tools are *presentation*. Gameplay time lives in core **[Bridge]**.

| Need | Lives in | Pattern |
|---|---|---|
| Cooldowns, spawn waves, buff durations | Core | `Cooldown { remaining }` decremented from `Time.delta` by a system |
| Sprite animation | Phaser: global definitions in `PreloadScene`; per-sprite AnimationState **[Phaser]** | Core sets `MoveState` / `Facing`; `sync-animations` plays a clip on `Changed(MoveState)` |
| Gameplay moment tied to an animation frame | Prefer core timing | If you must listen to Phaser animation events, translate to an **action** at the boundary (run-on-transition) |
| Juice: squash/stretch, flash, damage numbers, camera shake, particles | Phaser tweens, camera effects, particle emitters **[Phaser]** | `play-feedback` reacts to tracking queries: `Added(IsDead)` → burst; `Changed(Health)` → flash |
| Scripted sequences / cutscenes | Phaser `Timeline` **[Phaser]** | Keyframes call actions; gameplay state changes only through actions |
| Sound effects | Global SoundManager **[Phaser]** | `play-feedback` maps state transitions to sound keys |
| Music | Global SoundManager | Driven by scene changes or world state (`IsBossFight`) |
| Post-processing, lighting | v4 Filters, `setLighting` **[Phaser]** | Static setup in `{Domain}View`; dynamic tweaks react to traits |

Tracking modifiers reset after each query run, so each feedback system owns its own `createAdded()` / `createChanged()` instances at module scope **[Koota]**. `Changed` only sees `set()` and `entity.changed()` (and `updateEach` change detection) **[Koota]** — mutate AoS objects, then signal.

Pausing: `IsPaused` stops the simulation while views keep animating (menus, ambient FX). Phaser `scene.pause()` additionally stops that scene's update-driven plugins, such as its timers and timelines **[Phaser]**. Use blur/hidden game events to call the `pause` action **[Phaser]**.

---

## 13. Levels, tilemaps and spawning

- **Level root entity.** `startLevel` spawns `IsLevel + LevelInfo`; every spawn takes the level and adds `InLevel(level)`; `level.destroy()` on shutdown cascades **[Bridge]** on **[Koota]** `autoDestroy`.
- **Tilemaps split by purpose.** A Phaser `Tilemap` is a data container; `TilemapLayer` / `TilemapGPULayer` render it **[Phaser]**.
  - *Tile layers* (static environment) → rendered directly by Phaser in `features/environment`; they are not entities.
  - *Collision* → mode A: build a core `CollisionGrid` singleton from tile data; mode B: Phaser tile collision.
  - *Object layers* (spawn points, enemies, triggers) → read the object layer's data and call **spawn actions**. Don't use `createFromObjects` for gameplay entities — it creates Sprites directly and bypasses core **[Bridge]**.
- **Data-driven prefabs.** JSON definitions are loaded by Phaser's loader into the cache **[Phaser]**, parsed in the bridge, and handed to spawn actions as plain data. Core never touches the loader.

---

## 14. UI and HUD

Two supported shapes, same world:

**A. Phaser `HudScene`** (parallel, launched on top **[Phaser]**)

- Reads world singletons with `world.get()` and entity traits via queries each frame.
- World traits don't appear in queries **[Koota]**, so `Changed()` can't track them: dirty-check singleton values and call `setText` only when they differ. For entity traits (player `Health`), use `Changed` tracking.
- Buttons call actions. The HUD never runs core systems.

**B. React DOM overlay with `koota/react`** — best for menu-heavy games (inventory, crafting, settings)

- Phaser renders into a container with a transparent canvas **[Phaser]**; React renders DOM UI above it inside `WorldProvider` **[Koota]**.
- Use `useTrait`, `useQuery`, `useQueryFirst`, `useActions` **[Koota]**. Never store entities in `useState`/`useRef`; React doesn't own entity lifetime **[Koota]**.

Either way, **the world is the message bus.** No `game.events` or `registry` traffic for game state; Phaser's registry and DataManagers hold view-local scratch values at most **[Bridge]**.

---

## 15. Lifetimes and cleanup

| Lifetime | Koota | Phaser |
|---|---|---|
| Process | World, singleton traits, persistent entities (profile, settings) | `Game`, global managers: textures, cache, anims, sound, registry **[Phaser]** |
| Level / session | Level entity + `InLevel` children | One `LevelScene` run (create → shutdown) |
| Scene view | `Ref`, `Body`, `IsPhysicsDriven` | GameObjects, tweens, timers, input listeners (scene-owned) |
| Frame | Contact facts (`CollidingWith`), one-shot tags | — |

**On `SHUTDOWN`** (scene stops, restarts or is replaced) **[Bridge]**:

1. Unsubscribe every `world.onAdd` / `onRemove` / `onChange` / `onQueryAdd` / `onQueryRemove` (each returns an unsubscribe function **[Koota]**).
2. Remove Phaser listeners registered outside the scene's own emitter — `game.events`, `registry.events`, other scenes **[Phaser]**.
3. Remove `Ref` / `Body` from all bound entities. Phaser tears down the scene's display list on shutdown, so leftover refs would point at dead GameObjects.
4. Clear the view registry and pools.
5. If the level is ending: `level.destroy()`.

A per-scene `Disposables` helper collects steps 1–2 so `create()` can register cleanup next to each subscription. Restart order is `SHUTDOWN` → `START` → `CREATE` with no `DESTROY` **[Phaser]**; because binding uses `Not(Ref)`, the new run rebinds automatically.

---

## 16. Performance guidelines

**Koota side**

- `createQuery` at module scope for every per-frame query; inline queries are fine in event handlers and startup **[Koota]**.
- `updateEach` / `readEach` over `for…of` + `entity.get()` **[Koota]**; `select()` when the filter is wider than the data you write **[Koota]**.
- `useStores` for thousands of entities when profiling demands it — no automatic change detection **[Koota]**.
- `changeDetection: 'never'` for silent hot updates — then don't expect `Changed` to fire **[Koota]**.

**Phaser side**

- WebGL renderer; `Image` unless animated; Group pools for churn; `SpriteGPULayer` / `TilemapGPULayer` for massive static content **[Phaser]**.
- Avoid deep Containers; group lit and unlit objects to keep batches; filters cost extra draw calls **[Phaser]**.
- Physics debug off in production; consider disabling the Arcade RTree beyond ~5000 dynamic bodies **[Phaser]**.

**Bridge side**

- Sync transforms every frame (cheap). Sync expensive properties — texture, animation, tint, text, filters — only on `Changed`.
- Never create/destroy GameObjects per frame for transient entities; route through pools.
- In hot paths use the `Ref` trait, not `getData()`; the DataManager back-link is for event callbacks.

---

## 17. Testing and portability

- **Core tests run in plain Node** (Vitest/Jest): `createWorld` → actions → systems with a fixed `Time` → assert traits. No DOM and no Phaser. (Phaser's `HEADLESS` renderer still needs a DOM and is meant for unit testing Phaser code **[Phaser]**.)
- **Bridge and scene tests** are browser smoke tests: boot a scene, spawn via actions, assert GameObject counts and positions.
- **Saves and networking.** Entities are packed numbers (id + generation + world), safe for persistence and networking **[Koota]**. Serialise traits; on load, spawn entities and let bind-views rebuild the Phaser side.
- **Portability.** The same `core/` can drive a server, a worker or a different renderer — the payoff of keeping Phaser out of core **[Koota]**.

---

## 18. Anti-patterns

| Don't | Do instead | Why |
|---|---|---|
| Keep HP, score, inventory on GameObjects (`setData`) or in `registry` | Traits on entities / world singletons | One source of truth **[Koota]** |
| Subclass `Phaser.Sprite` with gameplay `update()` logic; use `runChildUpdate` for behaviour | Systems over queries; GameObject subclasses only for rendering concerns | Traits + actions over classes **[Koota]** |
| Import `phaser` anywhere in `core/` | Semantic traits + bridge systems | View decoupling **[Koota]** |
| Gameplay timers via `this.time` / tweens on gameplay values | `Cooldown` traits + systems | Pausable, serialisable, testable |
| Run core systems from several scenes | One simulation host | Reverse update order **[Phaser]** |
| Apply damage inside collider callbacks | Record `CollidingWith`; resolve in a core system | Rules stay in core |
| Leave `Ref` on entities after scene shutdown | Release views on `SHUTDOWN` | Phaser destroyed the objects |
| Forget `off()` / unsubscribe on shutdown | `Disposables` per scene | Duplicate listeners on restart **[Phaser]** |
| `parent` fields or child arrays in traits | Relations with `autoDestroy` | **[Koota]** relation anti-patterns |
| `createFromObjects` for gameplay entities | Read object-layer data, spawn via actions | Bypasses core |
| Raw event strings | Phaser event constants | Typos, autocomplete **[Phaser]** |
| Create tracking modifiers inside functions | Module-scope `createAdded()` etc. | Each instance tracks independently **[Koota]** |
| Use Phaser Containers to mirror `ChildOf` hierarchies | Core computes world transforms; flat GameObjects | Container cost and physics offsets **[Phaser]** |

---

## 19. Phaser 4 specifics to respect

- **WebGL first.** Canvas is deprecated in v4; `Phaser.AUTO` or `Phaser.WEBGL` (no fallback) **[Phaser]**.
- **Filters replace FX and masks.** `enableFilters()`, then `filters.internal` (object space, cheaper) or `filters.external` (screen space) **[Phaser]**.
- **Lighting is a component.** `setLighting(true)` replaces the Light2D pipeline **[Phaser]**.
- **Tint mode is separate from colour.** `setTintFill` is gone; use a tint mode **[Phaser]**.
- **`roundPixels` defaults to `false`.** `pixelArt: true` turns it on **[Phaser]**.
- **`Vector2` replaces `Point`; native `Set`/`Map` replace Phaser structs** **[Phaser]**.
- **Render nodes replace pipelines.** Don't make raw `gl` calls; use custom render nodes or an `Extern` object **[Phaser]**.
- **Removed:** `Mesh`, `Plane`, Camera3D/Layer3D plugins **[Phaser]**.
- **Defaults:** 1024×768 canvas (was 800×600 in v3); `EXPAND` scale mode for fill-the-parent layouts **[Phaser]**.

---

### Summary

```
core/        what the game IS and DOES      Koota: traits · relations · systems · actions · world
game/bridge  how the two meet               capture → (core) → bind → sync   (+ readback in mode B)
game/        how the game LOOKS and FEELS   Phaser: scenes · views · assets · audio · FX · physics backend
```

Phaser drives the clock, devices and pixels. Koota holds the truth. The bridge is small, ordered and the only code that imports both.