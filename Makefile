# Build and clean-up targets. Targets and what they cost: `make help`;
# the steps themselves: docs/tooling.md and docs/web-demo.md.
#
# `make` builds the web demo end to end. Every step is a file rule on the file
# its tool writes, so a finished step is skipped; to redo one, delete its output.
# A rebuilt Rust tool does not invalidate finished emulator runs (order-only).
# Everything derived lands in build/ (gitignored), web/dist and web/node_modules.
#
# The ROM comes from $KDC_ROM, else tools/romcheck.py's default path:
#     make KDC_ROM=/path/to/rom.sfc

PYTHON ?= python3
NPM    ?= npm
CARGO  ?= cargo

SNESSTEP  := build/snesstep/release/snesstep
SPCRENDER := build/spcrender/release/spcrender
SNESSTEP_SRC  := $(shell find tools/snesstep/src -name '*.rs') \
                 tools/snesstep/Cargo.toml tools/snesstep/Cargo.lock
SPCRENDER_SRC := $(shell find tools/spcrender/src -name '*.rs') \
                 tools/spcrender/Cargo.toml tools/spcrender/Cargo.lock

# The course-1 replay the sprite atlas is cut from: c1n when it is there (what
# tools/export_web_sprites.py prefers), else the run `autoplay.py --course 0` makes.
C1N    := build/emu/autoplay/c1n
REPLAY := $(firstword $(wildcard $(C1N)/pokes.txt) build/emu/autoplay/course1/pokes.txt)

# The replay hole 1's intro and hole-out are traced from. The tracer's frame
# windows belong to c1n, which no current tool recreates: course1 gives the same
# trace except the enemies' pictures in the hole-out (docs/web-demo.md). Without
# a replay the export leaves the cutscenes and the night layers out.
CUTSCENE_REPLAY ?= $(C1N)
CUTSCENE := $(if $(wildcard $(CUTSCENE_REPLAY)/pokes.txt)$(filter-out $(C1N),$(CUTSCENE_REPLAY)),build/web-test/cutscene_hole0.json)

AUDIO  := build/spc/wav/index.tsv
HUD    := build/screens/hole_in_play_layers/bg3.png
CLIPS  := build/sprites/kirby/clips/clips.json
ASSETS := build/web/manifest.json
NODE   := web/node_modules/.package-lock.json
DIST   := web/dist/index.html
WEB_SRC := $(shell find web/src -type f ! -path '*/__tests__/*' ! -name .DS_Store) \
           web/index.html web/hands.html web/vite.config.ts web/tsconfig.json web/package.json

.PHONY: all build tools assets web engine engine-assets engine-test engine-traces engine-e2e engine-random extract stems help clean clean-rust distclean
.DELETE_ON_ERROR:

all: build

build: tools web

tools: $(SNESSTEP) $(SPCRENDER)

assets: $(ASSETS)

web: $(DIST)

# ---- Rust tools (cargo --offline; touched so make sees them as current)

$(SNESSTEP): $(SNESSTEP_SRC)
	CARGO_TARGET_DIR=build/snesstep $(CARGO) build --release --offline --manifest-path tools/snesstep/Cargo.toml
	@touch $@

$(SPCRENDER): $(SPCRENDER_SRC)
	CARGO_TARGET_DIR=build/spcrender $(CARGO) build --release --offline --manifest-path tools/spcrender/Cargo.toml
	@touch $@

# ---- what tools/export_web.py reads from other tools' output

build/spc/driver_0800.bin:
	$(PYTHON) tools/spc_extract.py

build/spc/songs/summary.tsv: build/spc/driver_0800.bin
	$(PYTHON) tools/nspc.py --all --midi --spc

$(AUDIO): build/spc/songs/summary.tsv | $(SPCRENDER)
	$(PYTHON) tools/render_audio.py

$(HUD): | $(SNESSTEP)
	$(PYTHON) tools/snesstep/screens.py

$(CLIPS): tools/kirbyanim.py | $(SNESSTEP)
	$(PYTHON) tools/kirbyanim.py --make-base
	$(PYTHON) tools/kirbyanim.py --clips

build/emu/autoplay/course1/pokes.txt: | $(SNESSTEP)
	$(PYTHON) tools/snesstep/autoplay.py --course 0

build/web-test/cutscene_hole0.json: $(CUTSCENE_REPLAY)/pokes.txt tools/snesstep/trace_cutscene.py | $(SNESSTEP)
	$(PYTHON) tools/snesstep/trace_cutscene.py --replay $(CUTSCENE_REPLAY)

# ---- the web demo

# export_web.py writes manifest.json last
$(ASSETS): $(AUDIO) $(HUD) $(CLIPS) $(REPLAY) $(CUTSCENE) tools/web_audio_map.json \
           tools/export_web.py tools/export_web_sprites.py tools/export_web_ui.py tools/coursemap.py | $(SNESSTEP)
ifeq ($(CUTSCENE),)
	@echo "warning: no $(CUTSCENE_REPLAY)/pokes.txt: exporting without the intro, hole-out and night layers"
	@echo "         (make CUTSCENE_REPLAY=build/emu/autoplay/course1 traces a close substitute)"
endif
	$(PYTHON) tools/export_web.py --golden

$(NODE): web/package.json web/package-lock.json
	cd web && $(NPM) ci
	@touch $@

$(DIST): $(NODE) $(ASSETS) $(WEB_SRC)
	cd web && $(NPM) run build

# ---- the engine (Koota x Phaser 4; plans/port_v1_koota_phaser4.md)
#
# build/engine/rules      tables.json: the ROM physics constants (ROM only)
# build/engine/rom-test   course.json + terrain_golden.json (test hole), holes/N/
#                         course.json (course 1, the hazard holes 11 and 54, and
#                         hole 17, the boost panels),
#                         and, after `make engine-traces`, the ball, flow, sound
#                         and hazard-actor fixtures of tools/snesstep/inputs/web_*
# build/engine/assets     the sprite atlas, ui, hud, font, audio, cutscenes,
#                         the ROM holes' course.json + layers under holes/NNN
#                         (ENGINE_HOLES: courses 1-8 by default; the manifest
#                         lists them by course), and the course art's exemplar
#                         patches (terrain_style.*) the holes without bitmaps
#                         are drawn with

ENGINE_RULES   := build/engine/rules/tables.json
ENGINE_ROMTEST := build/engine/rom-test/.stamp
ENGINE_ASSETS  := build/engine/assets/manifest.json
ENGINE_NODE    := engine/node_modules/.package-lock.json
ENGINE_DIST    := engine/dist/index.html
# the hazard actors', the warp's and the snap stars' emulated sheets (tools/emusheets.py over
# every hole); the objects step skips a missing one and the engine draws a marker instead
ENGINE_OBJ     := $(wildcard $(foreach t,062 063 064 076 077 081 082 083,build/sprites/emu/obj_$(t).json))
ENGINE_SRC     := $(shell find engine/src engine/test -type f ! -name .DS_Store 2>/dev/null) \
                  engine/index.html engine/random.html engine/vite.config.ts engine/tsconfig.json engine/package.json
# The ROM holes the engine ships, by index (course * 8 + hole): 0-63 are the
# 1P courses 1-8; the extra game is 64-127. One file rule each, so `make -j`
# exports them in parallel; hole 0 also takes the night set from the cutscene trace.
ENGINE_HOLES   ?= $(shell seq 0 63)
ENGINE_HOLE_LAYERS := $(shell for h in $(ENGINE_HOLES); do printf 'build/engine/assets/holes/%03d/layers.json ' $$h; done)
ENGINE_HOLE_DEPS := tools/export_web.py tools/coursemap.py

$(ENGINE_RULES): tools/export_web.py
	$(PYTHON) tools/export_web.py --only tables --out build/engine/rules

# one recipe writes course.json (to --out) and terrain_golden.json (to --test-out)
$(ENGINE_ROMTEST): tools/export_web.py
	$(PYTHON) tools/export_web.py --only course,golden --out build/engine/rom-test --test-out build/engine/rom-test
	for h in 0 1 2 3 4 5 6 7 11 17 29 54 62; do \
	  $(PYTHON) tools/export_web.py --hole $$h --only course --out build/engine/rom-test/holes/$$h || exit; \
	done
	@touch $@

# every enemy species' idle clip (stepper runs, ~1 min): the sprites step adds them
ENGINE_SPECIES := build/sprites/enemies/species.json
$(ENGINE_SPECIES): tools/snesstep/trace_enemies.py | $(SNESSTEP)
	$(PYTHON) tools/snesstep/trace_enemies.py

# course.json + layers.json and the bitmaps of one hole (writes layers.json last)
build/engine/assets/holes/%/layers.json: $(ENGINE_HOLE_DEPS)
	$(PYTHON) tools/export_web.py --hole $* --only course,layers --out $(@D)

build/engine/assets/holes/000/layers.json: $(CUTSCENE) tools/export_web_sprites.py

# the water's objects and the guide's wet pictures are drawn from snapshots of
# web_water_shot (export_web_sprites.py, build/emu/water_ref)
$(ENGINE_ASSETS): $(AUDIO) $(HUD) $(CLIPS) $(REPLAY) $(CUTSCENE) $(ENGINE_OBJ) tools/web_audio_map.json \
                  tools/snesstep/inputs/web_water_shot.txt \
                  tools/export_web.py tools/export_web_sprites.py tools/export_web_ui.py tools/coursemap.py \
                  tools/terrain_style.py $(ENGINE_HOLE_LAYERS) $(ENGINE_SPECIES) | $(SNESSTEP)
ifeq ($(CUTSCENE),)
	@echo "warning: no $(CUTSCENE_REPLAY)/pokes.txt: exporting without the intro, hole-out and night layers"
	@echo "         (make CUTSCENE_REPLAY=build/emu/autoplay/course1 traces a close substitute)"
endif
	$(PYTHON) tools/export_web.py --only font,hud,sprites,ui,audio,objects --out build/engine/assets
	$(PYTHON) tools/terrain_style.py --out build/engine/assets
	$(PYTHON) tools/export_web.py --only manifest --out build/engine/assets

$(ENGINE_NODE): engine/package.json engine/package-lock.json
	cd engine && $(NPM) ci
	@touch $@

$(ENGINE_DIST): $(ENGINE_NODE) $(ENGINE_ASSETS) $(ENGINE_RULES) $(ENGINE_SRC)
	cd engine && $(NPM) run build

engine-assets: $(ENGINE_ASSETS)

engine: $(ENGINE_DIST)

engine-test: $(ENGINE_NODE) $(ENGINE_RULES) $(ENGINE_ROMTEST)
	cd engine && $(NPM) test

# the trace and flow fixtures the headless tests compare against (stepper runs)
engine-traces: | $(SNESSTEP)
	cd engine && $(NPM) run traces

# the browser smoke test: boots course 1, plays a shot, checks for errors.
# Needs `cd engine && npm run dev` running (port 5174), like web/test/e2e.
engine-e2e: $(ENGINE_NODE)
	cd engine && $(NPM) run e2e

# random.html: a course of random holes (plans/random_holes.md) on the dev
# server, opened in the browser; ?seed=N&difficulty=easy|normal|hard
engine-random: $(ENGINE_NODE) $(ENGINE_RULES) $(ENGINE_ASSETS)
	cd engine && $(NPM) run random

# ---- not part of `build`

extract: tools
	$(PYTHON) tools/extract_all.py

# Every song as stems, per voice and per sample, wet and dry: 9.1 GB, about
# 2 min on eight cores (docs/audio.md, "Stems"). One song: render_stems.py --song N.
stems: $(AUDIO) | $(SPCRENDER)
	$(PYTHON) tools/render_stems.py --all

help:
	@echo "make, make build   the web demo end to end: Rust tools, audio, screens, Kirby clips,"
	@echo "                   cutscene trace, tools/export_web.py, npm ci, vite build -> web/dist"
	@echo "                   (empty build/ but c1n: 3.5 min + npm ci, measured; then only what is missing)"
	@echo "make tools         build/snesstep and build/spcrender (cargo, offline)"
	@echo "make assets        build/web only (tools/export_web.py and what it needs)"
	@echo "make web           web/dist (vite build)"
	@echo "make engine        engine/dist (npm ci, vite build; needs engine-assets and the rules)"
	@echo "make engine-assets build/engine/assets: the ROM assets for the engine (like make assets)"
	@echo "make engine-e2e    browser smoke tests of the engine (needs cd engine && npm run dev)"
	@echo "make engine-random the dev server with random.html: a course of random holes"
	@echo "make engine-test   the engine's vitest suite (ROM-derived tests skip without build/engine)"
	@echo "make engine-traces the trace/flow fixtures into build/engine/rom-test (stepper runs)"
	@echo "make extract       tools/extract_all.py: every extractor + build/manifest.tsv"
	@echo "make stems         build/spc/stems: every song per voice and per sample, wet and dry"
	@echo "                   (9.1 GB, about 2 min; one song: tools/render_stems.py --song N)"
	@echo "make clean         web/dist, engine/dist, build/web, build/engine, __pycache__: seconds to redo"
	@echo "make clean-rust    the cargo target dirs build/snesstep, build/spcrender"
	@echo "make distclean     clean + web/node_modules + build/, except build/emu/autoplay/c1n"
	@echo ""
	@echo "variables: KDC_ROM=<rom>  CUTSCENE_REPLAY=<autoplay run>  PYTHON  NPM  CARGO"

# ---- clean-up, in three tiers

clean:
	rm -rf web/dist engine/dist build/web build/engine
	find tools -name __pycache__ -type d -prune -exec rm -rf {} +

clean-rust:
	rm -rf build/snesstep build/spcrender

# Keeps build/emu/autoplay/c1n: no current tool can record it again, and the
# cutscene trace is cut from it (docs/web-demo.md).
distclean: clean
	rm -rf web/node_modules engine/node_modules
	@if [ -d $(C1N) ]; then \
	  echo "keeping $(C1N)"; set -x; \
	  find build -mindepth 1 -maxdepth 1 ! -name emu -exec rm -rf {} +; \
	  find build/emu -mindepth 1 -maxdepth 1 ! -name autoplay -exec rm -rf {} +; \
	  find build/emu/autoplay -mindepth 1 -maxdepth 1 ! -name c1n -exec rm -rf {} +; \
	else \
	  set -x; rm -rf build; \
	fi
