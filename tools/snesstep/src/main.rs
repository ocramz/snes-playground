//! snesstep: a headless SNES CPU/bus stepper for static-analysis support.
//!
//! Runs the game's own code (65C816 + DMA/HDMA + a real SPC700/DSP) and
//! snapshots PPU memory. It renders no pixels; tools/ppu_render.py does that
//! from the snapshots. See docs/emulation.md.

mod bus;
mod cpu;
mod ppu;
mod sha1;
mod snapshot;
mod spc;
mod state;

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use bus::{fmt_snes, rom_file_offset, Bus, InputSpan};
use cpu::Cpu;

const DEFAULT_ROM: &str =
    "/Users/marco/Downloads/Kirby's Dream Course (USA)/Kirby's Dream Course (USA).sfc";
const ROM_SHA1: &str = "e1f29ad02981ec84156b68d4fb95b2182dc8cd82";
const SCENE_SETUP: u32 = 0x00_CABC; // sub_scene_screen_setup $80:CABC, normalised

const USAGE: &str = "\
usage: snesstep [ROM] [options]

  ROM                    default: $KDC_ROM, else the path in CLAUDE.md
  --frames N             stop when the frame counter reaches N (absolute)
  --out DIR              output directory (default build/emu/run)
  --input FILE           input script: 'FRAME BUTTONS [HOLD]' per line,
                         buttons B Y SELECT START UP DOWN LEFT RIGHT A X L R
                         joined with '+'; '#' starts a comment
  --snap-at F,F,...      snapshot at the start of vblank of these frames
  --snap-every N         snapshot every N frames
  --snap-on-pc ADDR      snapshot after the instruction at ADDR (repeatable)
  --snap-limit N         at most N --snap-on-pc snapshots (default 16)
  --snap-scenes          snapshot each screen set up via $80:CABC, once the
                         display has been fully bright for --scene-settle
                         frames (default 8); dirs <out>/sceneNN_cMMM/fFFFFFF
  --scene-settle N
  --log-pc ADDR          log registers on entry to ADDR (repeatable) -> pclog.tsv
  --log-vram-dma         log every DMA/HDMA/CPU write into VRAM/CGRAM/OAM -> xfer.tsv
  --log-apu              log S-CPU APU port writes and changed reads -> apu_ports.tsv
  --coverage FILE        every executed ROM instruction start with its M/X state (TSV)
  --trace N              instruction trace of N instructions -> trace.txt
  --trace-from F         start the trace at frame F (default 0)
  --save-state FILE      save the machine when the run ends
  --load-state FILE      start from a saved machine
  --sram FILE            load battery RAM (8 KB) at power-on
  --wav FILE             write the audio output (32 kHz stereo)
  --poke F:ADDR=VAL      at the start of vblank of frame F, write the 16-bit
                         VAL to WRAM ($7E/$7F) or SRAM ($70) (repeatable), e.g.
                         --poke '1450:$7E:6A5A=0003' to pick a course
  --poke-at-pc PC,ADDR=VAL
                         the same, but every time the instruction at PC is
                         about to run (repeatable), e.g. to force a branch:
                         --poke-at-pc '$80:F37A,$7E:D956=0001'
  --watch-write A[-B]    log every CPU write that changes a WRAM byte in
                         A..B (repeatable) -> watch.tsv: frame, line, the
                         writing instruction, address, old, new
  --no-dsp               do not step the S-DSP (faster; no audio)
  --quiet                no per-run summary
";

struct Opts {
    rom: PathBuf,
    frames: u64,
    out: PathBuf,
    input: Option<PathBuf>,
    snap_at: HashSet<u64>,
    snap_every: u64,
    snap_on_pc: Vec<u32>,
    snap_limit: u64,
    snap_scenes: bool,
    scene_settle: u32,
    log_pc: Vec<u32>,
    log_vram_dma: bool,
    log_apu: bool,
    coverage: Option<PathBuf>,
    trace: u64,
    trace_from: u64,
    save_state: Option<PathBuf>,
    load_state: Option<PathBuf>,
    sram: Option<PathBuf>,
    wav: Option<PathBuf>,
    pokes: Vec<(u64, u32, u16)>,
    pc_pokes: Vec<(u32, u32, u16)>,
    watch: Vec<(usize, usize)>,
    no_dsp: bool,
    quiet: bool,
}

fn parse_poke(s: &str) -> Result<(u64, u32, u16), String> {
    let bad = || format!("bad --poke {s}: want FRAME:ADDR=VALUE");
    let (frame, rest) = s.split_once(':').ok_or_else(bad)?;
    let (addr, value) = rest.split_once('=').ok_or_else(bad)?;
    let frame = frame.parse::<u64>().map_err(|_| bad())?;
    let addr = parse_addr(addr)?;
    if !matches!(addr >> 16, 0x7E | 0x7F | 0x70) {
        return Err(format!("--poke {s}: only WRAM ($7E/$7F) and SRAM ($70) can be poked"));
    }
    let value = u16::from_str_radix(value.trim_start_matches('$'), 16).map_err(|_| bad())?;
    Ok((frame, addr, value))
}

fn parse_addr(s: &str) -> Result<u32, String> {
    let t = s.trim().trim_start_matches('$');
    let (bank, off) = match t.split_once(':') {
        Some((b, o)) => (b, o),
        None if t.len() > 4 => (&t[..t.len() - 4], &t[t.len() - 4..]),
        None => ("80", t),
    };
    let bank = u32::from_str_radix(bank, 16).map_err(|_| format!("bad address {s}"))?;
    let off = u32::from_str_radix(off, 16).map_err(|_| format!("bad address {s}"))?;
    if bank > 0xFF || off > 0xFFFF {
        return Err(format!("bad address {s}"));
    }
    Ok((bank << 16) | off)
}

/// Fold an address to one key per byte of memory: ROM to its low-bank
/// alias, the low WRAM mirror to `$7E`.
fn norm(a: u32) -> u32 {
    let bank = (a >> 16) & 0xFF;
    let off = a & 0xFFFF;
    if bank == 0x7E || bank == 0x7F {
        return a;
    }
    if off >= 0x8000 {
        return ((bank & 0x7F) << 16) | off;
    }
    if bank & 0x40 == 0 && off < 0x2000 {
        return 0x7E_0000 | off;
    }
    a
}

fn parse_args() -> Result<Opts, String> {
    let mut o = Opts {
        rom: std::env::var_os("KDC_ROM").map_or_else(|| PathBuf::from(DEFAULT_ROM), PathBuf::from),
        frames: 600,
        out: PathBuf::from("build/emu/run"),
        input: None,
        snap_at: HashSet::new(),
        snap_every: 0,
        snap_on_pc: Vec::new(),
        snap_limit: 16,
        snap_scenes: false,
        scene_settle: 8,
        log_pc: Vec::new(),
        log_vram_dma: false,
        log_apu: false,
        coverage: None,
        trace: 0,
        trace_from: 0,
        save_state: None,
        load_state: None,
        sram: None,
        wav: None,
        pokes: Vec::new(),
        pc_pokes: Vec::new(),
        watch: Vec::new(),
        no_dsp: false,
        quiet: false,
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    let num = |v: &str| v.parse::<u64>().map_err(|_| format!("not a number: {v}"));
    while i < args.len() {
        let a = args[i].as_str();
        let mut val = || -> Result<String, String> {
            i += 1;
            args.get(i)
                .cloned()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        match a {
            "-h" | "--help" => return Err(String::new()),
            "--frames" => o.frames = num(&val()?)?,
            "--out" => o.out = PathBuf::from(val()?),
            "--input" => o.input = Some(PathBuf::from(val()?)),
            "--snap-at" => {
                for f in val()?.split(',').filter(|s| !s.is_empty()) {
                    o.snap_at.insert(num(f)?);
                }
            }
            "--snap-every" => o.snap_every = num(&val()?)?,
            "--snap-on-pc" => o.snap_on_pc.push(parse_addr(&val()?)?),
            "--snap-limit" => o.snap_limit = num(&val()?)?,
            "--snap-scenes" => o.snap_scenes = true,
            "--scene-settle" => o.scene_settle = num(&val()?)? as u32,
            "--log-pc" => o.log_pc.push(parse_addr(&val()?)?),
            "--log-vram-dma" => o.log_vram_dma = true,
            "--log-apu" => o.log_apu = true,
            "--coverage" => o.coverage = Some(PathBuf::from(val()?)),
            "--trace" => o.trace = num(&val()?)?,
            "--trace-from" => o.trace_from = num(&val()?)?,
            "--save-state" => o.save_state = Some(PathBuf::from(val()?)),
            "--load-state" => o.load_state = Some(PathBuf::from(val()?)),
            "--sram" => o.sram = Some(PathBuf::from(val()?)),
            "--wav" => o.wav = Some(PathBuf::from(val()?)),
            "--poke" => o.pokes.push(parse_poke(&val()?)?),
            "--poke-at-pc" => {
                let v = val()?;
                let (pc, rest) = v
                    .split_once(',')
                    .ok_or_else(|| format!("bad --poke-at-pc {v}: want PC,ADDR=VALUE"))?;
                let (_, addr, value) = parse_poke(&format!("0:{rest}"))?;
                o.pc_pokes.push((norm(parse_addr(pc)?), addr, value));
            }
            "--watch-write" => {
                let v = val()?;
                let (a, b) = v.split_once('-').unwrap_or((&v, &v));
                let (a, b) = (parse_addr(a)?, parse_addr(b)?);
                if !matches!(a >> 16, 0x7E | 0x7F) || !matches!(b >> 16, 0x7E | 0x7F) {
                    return Err(format!("--watch-write {v}: WRAM ($7E/$7F) only"));
                }
                o.watch.push(((a & 0x1FFFF) as usize, (b & 0x1FFFF) as usize));
            }
            "--no-dsp" => o.no_dsp = true,
            "--quiet" => o.quiet = true,
            _ if !a.starts_with("--") => o.rom = PathBuf::from(a),
            _ => return Err(format!("unknown option {a}")),
        }
        i += 1;
    }
    Ok(o)
}

const BUTTONS: [(&str, u16); 12] = [
    ("B", 0x8000),
    ("Y", 0x4000),
    ("SELECT", 0x2000),
    ("START", 0x1000),
    ("UP", 0x0800),
    ("DOWN", 0x0400),
    ("LEFT", 0x0200),
    ("RIGHT", 0x0100),
    ("A", 0x0080),
    ("X", 0x0040),
    ("L", 0x0020),
    ("R", 0x0010),
];

fn parse_input(path: &Path) -> Result<Vec<InputSpan>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut spans = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        let bad = || {
            format!(
                "{}:{}: expected 'FRAME BUTTONS [HOLD]'",
                path.display(),
                n + 1
            )
        };
        if f.len() < 2 || f.len() > 3 {
            return Err(bad());
        }
        let start: u64 = f[0].parse().map_err(|_| bad())?;
        let hold: u64 = if f.len() == 3 {
            f[2].parse().map_err(|_| bad())?
        } else {
            1
        };
        let mut mask = 0u16;
        for b in f[1].split('+') {
            let b = b.to_ascii_uppercase();
            if b == "NONE" {
                continue;
            }
            let bit = BUTTONS
                .iter()
                .find(|(name, _)| *name == b)
                .ok_or_else(|| format!("{}:{}: unknown button {b}", path.display(), n + 1))?
                .1;
            mask |= bit;
        }
        spans.push(InputSpan {
            start,
            end: start + hold,
            mask,
        });
    }
    Ok(spans)
}

const MNEMONICS: &str = "\
BRK ORA COP ORA TSB ORA ASL ORA PHP ORA ASL PHD TSB ORA ASL ORA \
BPL ORA ORA ORA TRB ORA ASL ORA CLC ORA INC TCS TRB ORA ASL ORA \
JSR AND JSL AND BIT AND ROL AND PLP AND ROL PLD BIT AND ROL AND \
BMI AND AND AND BIT AND ROL AND SEC AND DEC TSC BIT AND ROL AND \
RTI EOR WDM EOR MVP EOR LSR EOR PHA EOR LSR PHK JMP EOR LSR EOR \
BVC EOR EOR EOR MVN EOR LSR EOR CLI EOR PHY TCD JML EOR LSR EOR \
RTS ADC PER ADC STZ ADC ROR ADC PLA ADC ROR RTL JMP ADC ROR ADC \
BVS ADC ADC ADC STZ ADC ROR ADC SEI ADC PLY TDC JMP ADC ROR ADC \
BRA STA BRL STA STY STA STX STA DEY BIT TXA PHB STY STA STX STA \
BCC STA STA STA STY STA STX STA TYA STA TXS TXY STZ STA STZ STA \
LDY LDA LDX LDA LDY LDA LDX LDA TAY LDA TAX PLB LDY LDA LDX LDA \
BCS LDA LDA LDA LDY LDA LDX LDA CLV LDA TSX TYX LDY LDA LDX LDA \
CPY CMP REP CMP CPY CMP DEC CMP INY CMP DEX WAI CPY CMP DEC CMP \
BNE CMP CMP CMP PEI CMP DEC CMP CLD CMP PHX STP JML CMP DEC CMP \
CPX SBC SEP SBC CPX SBC INC SBC INX SBC NOP XBA CPX SBC INC SBC \
BEQ SBC SBC SBC PEA SBC INC SBC SED SBC PLX XCE JSR SBC INC SBC";

/// Instruction length by opcode; 5 = 2 or 3 by M, 6 = 2 or 3 by X.
const OP_LEN: &str = "\
2222222215113334\
2222222213113334\
3242222215113334\
2222222213113334\
1223222215113334\
2223222213114334\
1232222215113334\
2222222213113334\
2232222215113334\
2222222213113334\
6262222215113334\
2222222213113334\
6222222215113334\
2222222213113334\
6222222215113334\
2222322213113334";

fn op_len(op: u8, m8: bool, x8: bool) -> u32 {
    match OP_LEN.as_bytes()[usize::from(op)] - b'0' {
        5 => 2 + u32::from(!m8),
        6 => 2 + u32::from(!x8),
        n => u32::from(n),
    }
}

/// Pending screen snapshot for --snap-scenes.
struct SceneWait {
    scene: u16,
    call: u32,
    frame: u64,
    bright: u32,
}

struct Runner {
    o: Opts,
    pc_hooks: Vec<u64>,
    any_hooks: bool,
    log_set: HashSet<u32>,
    snap_set: HashSet<u32>,
    pclog: Option<BufWriter<File>>,
    trace_out: Option<BufWriter<File>>,
    trace_left: u64,
    coverage: Vec<u8>,
    snaps_on_pc: u64,
    used_dirs: HashSet<PathBuf>,
    snapshots: Vec<String>,
    /// Vblank snapshots still waiting for their `*_post.bin` files.
    pending_post: Vec<PathBuf>,
    scene_wait: Option<SceneWait>,
    scene_calls: u32,
    scene_index: Option<BufWriter<File>>,
    mnem: Vec<&'static str>,
}

impl Runner {
    fn snap(&mut self, cpu: &Cpu, base: &Path, reason: &str) {
        let mut dir = base.join(format!("f{:06}", cpu.bus.frame));
        let mut k = 2;
        while self.used_dirs.contains(&dir) {
            dir = base.join(format!("f{:06}_{}", cpu.bus.frame, k));
            k += 1;
        }
        self.used_dirs.insert(dir.clone());
        if let Err(e) = snapshot::write(cpu, &dir, reason) {
            eprintln!("snapshot {}: {e}", dir.display());
            return;
        }
        self.snapshots
            .push(format!("{}\t{}", dir.display(), reason));
        self.pending_post.push(dir);
    }

    fn log_pc(&mut self, cpu: &Cpu) {
        let b = &cpu.bus;
        let s = u32::from(cpu.s);
        let r = [
            b.peek(s + 1),
            b.peek((s + 2) & 0xFFFF),
            b.peek((s + 3) & 0xFFFF),
        ];
        let ret_long =
            (u32::from(r[2]) << 16) | u32::from(u16::from_le_bytes([r[0], r[1]]).wrapping_add(1));
        if let Some(out) = self.pclog.as_mut() {
            let _ = writeln!(
                out,
                "{}\t{}\t{}\t{}\t{:04X}\t{:04X}\t{:04X}\t{:04X}\t{:04X}\t{:02X}\t{:02X}\t{:02X} {:02X} {:02X}\t{}",
                b.frame,
                b.vline,
                b.hpos(),
                fmt_snes(cpu.pc24()),
                cpu.a,
                cpu.x,
                cpu.y,
                cpu.s,
                cpu.d,
                cpu.db,
                cpu.p,
                r[0],
                r[1],
                r[2],
                fmt_snes(ret_long)
            );
        }
    }

    fn trace(&mut self, cpu: &Cpu) {
        let pc = cpu.pc24();
        let b = &cpu.bus;
        let op = b.peek(pc);
        let o1 = b.peek((pc & 0xFF_0000) | ((pc + 1) & 0xFFFF));
        let o2 = b.peek((pc & 0xFF_0000) | ((pc + 2) & 0xFFFF));
        let o3 = b.peek((pc & 0xFF_0000) | ((pc + 3) & 0xFFFF));
        let m = self.mnem[usize::from(op)];
        if let Some(out) = self.trace_out.as_mut() {
            let _ = writeln!(
                out,
                "f{} l{:3} h{:4} {} {:02X} {:02X} {:02X} {:02X} {}  A={:04X} X={:04X} Y={:04X} S={:04X} D={:04X} DB={:02X} P={:02X}{}",
                b.frame,
                b.vline,
                b.hpos(),
                fmt_snes(pc),
                op,
                o1,
                o2,
                o3,
                m,
                cpu.a,
                cpu.x,
                cpu.y,
                cpu.s,
                cpu.d,
                cpu.db,
                cpu.p,
                if cpu.e { " E" } else { "" }
            );
        }
    }

    fn on_scene_call(&mut self, cpu: &Cpu) {
        self.scene_calls += 1;
        let scene = cpu.a & if cpu.p & cpu::FM != 0 { 0xFF } else { 0xFFFF };
        if let Some(out) = self.scene_index.as_mut() {
            let _ = writeln!(
                out,
                "{}\t{}\t{}\tcall",
                self.scene_calls, scene, cpu.bus.frame
            );
        }
        if let Some(w) = self.scene_wait.take() {
            // The previous screen never settled; keep what it had.
            self.snap_scene(cpu, &w, "scene-preempted");
        }
        self.scene_wait = Some(SceneWait {
            scene,
            call: self.scene_calls,
            frame: cpu.bus.frame,
            bright: 0,
        });
    }

    fn snap_scene(&mut self, cpu: &Cpu, w: &SceneWait, why: &str) {
        let base = self
            .o
            .out
            .join(format!("scene{:02}_c{:03}", w.scene, w.call));
        let reason = format!(
            "{why} scene={} call={} call_frame={}",
            w.scene, w.call, w.frame
        );
        self.snap(cpu, &base, &reason);
        if let Some(out) = self.scene_index.as_mut() {
            let _ = writeln!(out, "{}\t{}\t{}\t{}", w.call, w.scene, cpu.bus.frame, why);
        }
    }

    fn on_vblank(&mut self, cpu: &Cpu) {
        let f = cpu.bus.frame;
        let periodic = self.o.snap_every > 0 && f % self.o.snap_every == 0;
        if self.o.snap_at.contains(&f) || periodic {
            let out = self.o.out.clone();
            self.snap(cpu, &out, "vblank");
        }
        if let Some(mut w) = self.scene_wait.take() {
            let ini = cpu.bus.ppu.raw[0];
            if ini & 0x80 == 0 && ini & 0x0F == 0x0F {
                w.bright += 1;
            } else {
                w.bright = 0;
            }
            if w.bright >= self.o.scene_settle {
                self.snap_scene(cpu, &w, "scene");
            } else {
                self.scene_wait = Some(w);
            }
        }
    }
}

fn run() -> Result<(), String> {
    let o = parse_args().map_err(|e| {
        if e.is_empty() {
            USAGE.to_string()
        } else {
            format!("{e}\n\n{USAGE}")
        }
    })?;
    let rom = fs::read(&o.rom).map_err(|e| format!("{}: {e}", o.rom.display()))?;
    let digest = sha1::sha1_hex(&rom);
    if digest != ROM_SHA1 {
        return Err(format!(
            "ROM SHA-1 {digest} does not match {ROM_SHA1}; every offset in this repo assumes that dump"
        ));
    }
    fs::create_dir_all(&o.out).map_err(|e| format!("{}: {e}", o.out.display()))?;

    let mut bus = Bus::new(rom);
    bus.dsp_on = !o.no_dsp;
    if o.wav.is_some() {
        bus.dsp_on = true;
        bus.audio = Some(Vec::new());
    }
    if let Some(p) = &o.sram {
        let d = fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
        let n = d.len().min(bus.sram.len());
        bus.sram[..n].copy_from_slice(&d[..n]);
    }
    if let Some(p) = &o.input {
        bus.inputs = parse_input(p)?;
    }
    if !o.watch.is_empty() {
        bus.watch = o.watch.clone();
        let mut f =
            BufWriter::new(File::create(o.out.join("watch.tsv")).map_err(|e| e.to_string())?);
        let _ = writeln!(f, "frame\tline\tpc\taddr\told\tnew");
        bus.watch_log = Some(f);
    }
    if o.log_vram_dma {
        bus.xfer_log = Some(bus::XferLog::new(&o.out.join("xfer.tsv")).map_err(|e| e.to_string())?);
    }
    if o.log_apu {
        let mut f =
            BufWriter::new(File::create(o.out.join("apu_ports.tsv")).map_err(|e| e.to_string())?);
        let _ = writeln!(f, "frame\tline\tpc\tdir\tport\tvalue");
        bus.apu_log = Some(f);
    }
    let mut cpu = Cpu::new(bus);
    if let Some(p) = &o.load_state {
        let d = fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
        if d.len() < 8 || &d[..8] != state::MAGIC {
            return Err(format!("{}: not a snesstep state", p.display()));
        }
        let mut r = state::Reader::new(&d[8..]);
        cpu.load_state(&mut r);
        if r.remaining() != 0 {
            return Err(format!("{}: state size mismatch", p.display()));
        }
    }

    let mut runner = Runner {
        pc_hooks: vec![0u64; 1 << 18],
        any_hooks: false,
        log_set: o.log_pc.iter().map(|&a| norm(a)).collect(),
        snap_set: o.snap_on_pc.iter().map(|&a| norm(a)).collect(),
        pclog: None,
        trace_out: None,
        trace_left: o.trace,
        coverage: if o.coverage.is_some() {
            vec![0u8; cpu.bus.rom.len()]
        } else {
            Vec::new()
        },
        snaps_on_pc: 0,
        used_dirs: HashSet::new(),
        snapshots: Vec::new(),
        pending_post: Vec::new(),
        scene_wait: None,
        scene_calls: 0,
        scene_index: None,
        mnem: MNEMONICS.split(' ').collect(),
        o,
    };
    assert_eq!(runner.mnem.len(), 256);
    let mut hook_keys: Vec<u32> = runner
        .log_set
        .iter()
        .chain(runner.snap_set.iter())
        .copied()
        .chain(runner.o.pc_pokes.iter().map(|p| p.0))
        .collect();
    if runner.o.snap_scenes {
        hook_keys.push(SCENE_SETUP);
        let mut f = BufWriter::new(
            File::create(runner.o.out.join("scenes.tsv")).map_err(|e| e.to_string())?,
        );
        let _ = writeln!(f, "call\tscene\tframe\tevent");
        runner.scene_index = Some(f);
    }
    for k in hook_keys {
        runner.pc_hooks[(k >> 6) as usize] |= 1 << (k & 63);
        runner.any_hooks = true;
    }
    if !runner.log_set.is_empty() {
        let mut f = BufWriter::new(
            File::create(runner.o.out.join("pclog.tsv")).map_err(|e| e.to_string())?,
        );
        let _ = writeln!(
            f,
            "frame\tline\thpos\tpc\ta\tx\ty\ts\td\tdb\tp\tstack\tret_long"
        );
        runner.pclog = Some(f);
    }
    if runner.o.trace > 0 {
        runner.trace_out = Some(BufWriter::new(
            File::create(runner.o.out.join("trace.txt")).map_err(|e| e.to_string())?,
        ));
    }

    let t0 = Instant::now();
    let start_frame = cpu.bus.frame;
    let start_clock = cpu.bus.clock;
    let stop = runner.o.frames;
    let coverage_on = runner.o.coverage.is_some();
    while cpu.bus.frame < stop {
        if cpu.ready() {
            let pc = cpu.pc24();
            let mut snap_after = false;
            if runner.any_hooks {
                let k = norm(pc);
                if runner.pc_hooks[(k >> 6) as usize] & (1 << (k & 63)) != 0 {
                    if runner.log_set.contains(&k) {
                        runner.log_pc(&cpu);
                    }
                    if runner.snap_set.contains(&k) && runner.snaps_on_pc < runner.o.snap_limit {
                        snap_after = true;
                    }
                    if k == SCENE_SETUP && runner.o.snap_scenes {
                        runner.on_scene_call(&cpu);
                    }
                    for &(ppc, addr, value) in &runner.o.pc_pokes {
                        if ppc == k {
                            let i = (addr & 0x1FFFF) as usize;
                            cpu.bus.wram[i] = value as u8;
                            cpu.bus.wram[(i + 1) & 0x1FFFF] = (value >> 8) as u8;
                        }
                    }
                }
            }
            if coverage_on && pc & 0x8000 != 0 && (pc >> 17) != 0x3F {
                let idx = (((pc >> 16) & 0x7F) * 0x8000 + ((pc & 0xFFFF) - 0x8000)) as usize;
                if idx < runner.coverage.len() {
                    let bit =
                        (u8::from(cpu.p & cpu::FM != 0) << 1) | u8::from(cpu.p & cpu::FX != 0);
                    runner.coverage[idx] |= 1 << bit;
                }
            }
            if runner.trace_left > 0 && cpu.bus.frame >= runner.o.trace_from {
                runner.trace_left -= 1;
                runner.trace(&cpu);
            }
            cpu.exec_next();
            if snap_after {
                runner.snaps_on_pc += 1;
                let out = runner.o.out.clone();
                runner.snap(&cpu, &out, &format!("after {}", fmt_snes(pc)));
            }
        }
        if cpu.bus.clock >= cpu.bus.next_event {
            cpu.bus.run_events();
        }
        if cpu.bus.frame_start_event {
            cpu.bus.frame_start_event = false;
            for dir in runner.pending_post.drain(..) {
                if let Err(e) = snapshot::write_post(&cpu, &dir) {
                    eprintln!("snapshot {}: {e}", dir.display());
                }
            }
        }
        if cpu.bus.vblank_event {
            cpu.bus.vblank_event = false;
            for &(f, addr, value) in &runner.o.pokes {
                if f == cpu.bus.frame {
                    if addr >> 16 == 0x70 {
                        // Battery RAM: 8 KB at $70:0000-$1FFF.
                        let i = (addr & 0x1FFF) as usize;
                        cpu.bus.sram[i] = value as u8;
                        cpu.bus.sram[(i + 1) & 0x1FFF] = (value >> 8) as u8;
                        continue;
                    }
                    let i = (addr & 0x1FFFF) as usize;
                    cpu.bus.wram[i] = value as u8;
                    cpu.bus.wram[(i + 1) & 0x1FFFF] = (value >> 8) as u8;
                }
            }
            runner.on_vblank(&cpu);
        }
    }
    cpu.bus.sync_apu();
    let elapsed = t0.elapsed().as_secs_f64();

    // Outputs.
    if let Some(l) = cpu.bus.xfer_log.as_mut() {
        l.finish();
    }
    if let Some(f) = cpu.bus.apu_log.as_mut() {
        let _ = f.flush();
    }
    if let Some(f) = cpu.bus.watch_log.as_mut() {
        let _ = f.flush();
    }
    if let Some(f) = runner.pclog.as_mut() {
        let _ = f.flush();
    }
    if let Some(f) = runner.trace_out.as_mut() {
        let _ = f.flush();
    }
    if let Some(f) = runner.scene_index.as_mut() {
        let _ = f.flush();
    }
    if let Some(p) = runner.o.coverage.clone() {
        let mut f = BufWriter::new(File::create(&p).map_err(|e| e.to_string())?);
        let _ = writeln!(f, "snes_addr\tfile_offset\tm\tx\tlen");
        let mut n = 0u64;
        for (i, &bits) in runner.coverage.iter().enumerate() {
            for b in 0..4u8 {
                if bits & (1 << b) != 0 {
                    let snes =
                        ((((i / 0x8000) as u32) | 0x80) << 16) | ((i % 0x8000) as u32 + 0x8000);
                    let m = if b & 2 != 0 { 8 } else { 16 };
                    let x = if b & 1 != 0 { 8 } else { 16 };
                    let len = op_len(cpu.bus.rom[i], m == 8, x == 8);
                    let _ = writeln!(f, "{}\t0x{:06X}\t{}\t{}\t{}", fmt_snes(snes), i, m, x, len);
                }
            }
            if bits != 0 {
                n += 1;
            }
        }
        let _ = f.flush();
        if !runner.o.quiet {
            eprintln!("coverage: {n} instruction starts -> {}", p.display());
        }
    }
    if let Some(p) = &runner.o.wav {
        if let Some(a) = cpu.bus.audio.as_ref() {
            spc::wav::write_wav(p, 2, a).map_err(|e| e.to_string())?;
        }
    }
    if let Some(p) = &runner.o.save_state {
        let mut w = state::Writer::default();
        w.bytes(state::MAGIC);
        cpu.save_state(&mut w);
        fs::write(p, &w.buf).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    if !runner.snapshots.is_empty() {
        let mut idx = String::from("dir\treason\n");
        for s in &runner.snapshots {
            idx.push_str(s);
            idx.push('\n');
        }
        let _ = fs::write(runner.o.out.join("snapshots.tsv"), idx);
    }
    if !runner.o.quiet {
        let frames = cpu.bus.frame - start_frame;
        let b = &cpu.bus;
        eprintln!(
            "frames {}..{} ({} frames) in {:.2}s = {:.0} frames/s ({:.1}x real time)",
            start_frame,
            b.frame,
            frames,
            elapsed,
            frames as f64 / elapsed.max(1e-9),
            frames as f64 / 60.0988 / elapsed.max(1e-9)
        );
        eprintln!(
            "instructions {}  master cycles {}  NMIs {}  DMA {} ({} bytes)  HDMA lines {}",
            cpu.instructions,
            b.clock - start_clock,
            b.nmi_count,
            b.dma_count,
            b.dma_bytes,
            b.hdma_lines
        );
        eprintln!(
            "pc {}  P={:02X} E={}  waiting={} stopped={}  SPC pc ${:04X} ({} instr)  ports out {:02X?}",
            fmt_snes(cpu.pc24()),
            cpu.p,
            cpu.e,
            cpu.waiting,
            cpu.stopped,
            b.apu.pc,
            b.apu.instructions,
            b.apu.port_out
        );
        eprintln!(
            "VRAM writes dropped during active display: {}  CGRAM/OAM writes outside blanking: {}/{}",
            b.ppu.vram_blocked, b.ppu.cgram_active_writes, b.ppu.oam_active_writes
        );
        if !runner.snapshots.is_empty() {
            eprintln!(
                "{} snapshots under {}",
                runner.snapshots.len(),
                runner.o.out.display()
            );
        }
        if let Some(l) = b.xfer_log.as_ref() {
            eprintln!("transfer log: {} records", l.records);
        }
        let _ = rom_file_offset;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
