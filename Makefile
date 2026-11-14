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

.PHONY: all build tools assets web extract help clean clean-rust distclean
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

$(CLIPS): | $(SNESSTEP)
	$(PYTHON) tools/kirbyanim.py --make-base
	$(PYTHON) tools/kirbyanim.py --clips

build/emu/autoplay/course1/pokes.txt: | $(SNESSTEP)
	$(PYTHON) tools/snesstep/autoplay.py --course 0

build/web-test/cutscene_hole0.json: $(CUTSCENE_REPLAY)/pokes.txt tools/snesstep/trace_cutscene.py | $(SNESSTEP)
	$(PYTHON) tools/snesstep/trace_cutscene.py --replay $(CUTSCENE_REPLAY)

# ---- the web demo

# export_web.py writes manifest.json last
$(ASSETS): $(AUDIO) $(HUD) $(CLIPS) $(REPLAY) $(CUTSCENE) tools/web_audio_map.json \
           tools/export_web.py tools/export_web_sprites.py tools/export_web_ui.py | $(SNESSTEP)
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

# ---- not part of `build`

extract: tools
	$(PYTHON) tools/extract_all.py

help:
	@echo "make, make build   the web demo end to end: Rust tools, audio, screens, Kirby clips,"
	@echo "                   cutscene trace, tools/export_web.py, npm ci, vite build -> web/dist"
	@echo "                   (empty build/ but c1n: 3.5 min + npm ci, measured; then only what is missing)"
	@echo "make tools         build/snesstep and build/spcrender (cargo, offline)"
	@echo "make assets        build/web only (tools/export_web.py and what it needs)"
	@echo "make web           web/dist (vite build)"
	@echo "make extract       tools/extract_all.py: every extractor + build/manifest.tsv"
	@echo "make clean         web/dist, build/web, __pycache__: seconds to redo"
	@echo "make clean-rust    the cargo target dirs build/snesstep, build/spcrender"
	@echo "make distclean     clean + web/node_modules + build/, except build/emu/autoplay/c1n"
	@echo ""
	@echo "variables: KDC_ROM=<rom>  CUTSCENE_REPLAY=<autoplay run>  PYTHON  NPM  CARGO"

# ---- clean-up, in three tiers

clean:
	rm -rf web/dist build/web
	find tools -name __pycache__ -type d -prune -exec rm -rf {} +

clean-rust:
	rm -rf build/snesstep build/spcrender

# Keeps build/emu/autoplay/c1n: no current tool can record it again, and the
# cutscene trace is cut from it (docs/web-demo.md).
distclean: clean
	rm -rf web/node_modules
	@if [ -d $(C1N) ]; then \
	  echo "keeping $(C1N)"; set -x; \
	  find build -mindepth 1 -maxdepth 1 ! -name emu -exec rm -rf {} +; \
	  find build/emu -mindepth 1 -maxdepth 1 ! -name autoplay -exec rm -rf {} +; \
	  find build/emu/autoplay -mindepth 1 -maxdepth 1 ! -name c1n -exec rm -rf {} +; \
	else \
	  set -x; rm -rf build; \
	fi
