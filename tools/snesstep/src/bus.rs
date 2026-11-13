//! The S-CPU's world: memory map, CPU I/O registers (`$4200-$437F`), DMA and
//! HDMA, the scanline/frame clock, the joypads, and the APU ports.
//!
//! Timing (fullsnes "CPU Clock Cycles" / "SNES Timing H/V Events"):
//! every CPU access is charged 6, 8 or 12 master cycles by address; a frame
//! is 262 lines of 1364 cycles; the CPU loses 40 cycles per line to DRAM
//! refresh at H=133.5 (cycle 538 here); HDMA runs at H=278 (cycle 1104) on
//! lines 0-224 and is reloaded at the start of line 0; vblank, the NMI flag,
//! the auto-joypad read and the OAM address reload happen at the start of
//! line 225. Events are checked between CPU instructions and between DMA
//! bytes, so they land up to one instruction late.

use std::fs::File;
use std::io::{BufWriter, Write};

use crate::ppu::{PortWrite, Ppu, Target, NREGS};
use crate::spc::apu::Apu;

pub const LINE_CYCLES: u64 = 1364;
pub const LINES: u16 = 262;
pub const VBLANK_LINE: u16 = 225;
const REFRESH_POS: u64 = 538;
const HDMA_POS: u64 = 1104;
const MASTER_HZ: u128 = 21_477_270;
const SPC_HZ: u128 = 1_024_000;

/// B-bus offsets per transfer unit index, fullsnes "DMA Transfer Unit Selection".
const UNIT: [[u8; 4]; 8] = [
    [0, 0, 0, 0],
    [0, 1, 0, 1],
    [0, 0, 0, 0],
    [0, 0, 1, 1],
    [0, 1, 2, 3],
    [0, 1, 0, 1],
    [0, 0, 0, 0],
    [0, 0, 1, 1],
];
const UNIT_LEN: [u8; 8] = [1, 2, 2, 4, 4, 4, 2, 4];

#[derive(Clone, Copy, Default)]
pub struct Channel {
    pub dmap: u8,
    pub bbad: u8,
    pub a1t: u16,
    pub a1b: u8,
    pub das: u16,
    pub dasb: u8,
    pub a2a: u16,
    pub ntrl: u8,
    pub unused: u8,
    hdma_completed: bool,
    hdma_do_transfer: bool,
}

/// One coalesced run of writes into VRAM/CGRAM/OAM, for `--log-vram-dma`.
struct Run {
    frame: u64,
    line: u16,
    kind: &'static str,
    ch: i8,
    pc: u32,
    src_start: u32,
    src_last: u32,
    has_src: bool,
    target: Target,
    dest_start: u32,
    dest_last: u32,
    bytes: u32,
    dropped: u32,
    mode: u8,
    bbad: u8,
    vmain: u8,
}

pub struct XferLog {
    out: BufWriter<File>,
    run: Option<Run>,
    pub records: u64,
}

impl XferLog {
    pub fn new(path: &std::path::Path) -> std::io::Result<Self> {
        let mut out = BufWriter::new(File::create(path)?);
        writeln!(
            out,
            "frame\tline\tkind\tch\tpc\tsrc\tsrc_end\tsrc_file\ttarget\tdest\tdest_end\tbytes\tdropped\tmode\tbbad\tvmain"
        )?;
        Ok(Self {
            out,
            run: None,
            records: 0,
        })
    }

    fn flush_run(&mut self) {
        if let Some(r) = self.run.take() {
            let (src, src_end, src_file) = if r.has_src {
                (
                    fmt_snes(r.src_start),
                    fmt_snes(r.src_last),
                    rom_file_offset(r.src_start),
                )
            } else {
                ("-".to_string(), "-".to_string(), "-".to_string())
            };
            let width = match r.target {
                Target::Vram => 4,
                Target::Cgram => 2,
                Target::Oam => 3,
            };
            let _ = writeln!(
                self.out,
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t${:0w$X}\t${:0w$X}\t{}\t{}\t{}\t$21{:02X}\t${:02X}",
                r.frame,
                r.line,
                r.kind,
                if r.ch < 0 { "-".to_string() } else { r.ch.to_string() },
                fmt_snes(r.pc),
                src,
                src_end,
                src_file,
                r.target.name(),
                r.dest_start,
                r.dest_last,
                r.bytes,
                r.dropped,
                r.mode,
                r.bbad,
                r.vmain,
                w = width
            );
            self.records += 1;
        }
    }

    pub fn finish(&mut self) {
        self.flush_run();
        let _ = self.out.flush();
    }
}

pub fn fmt_snes(a: u32) -> String {
    format!("${:02X}:{:04X}", (a >> 16) & 0xFF, a & 0xFFFF)
}

/// File offset of a LoROM address, or "-" when it is not ROM.
pub fn rom_file_offset(a: u32) -> String {
    let bank = (a >> 16) & 0xFF;
    let off = a & 0xFFFF;
    if off < 0x8000 || bank == 0x7E || bank == 0x7F {
        return "-".to_string();
    }
    format!("0x{:06X}", (bank & 0x7F) * 0x8000 + (off - 0x8000))
}

/// One input-script entry: buttons held for frames `start..end`.
#[derive(Clone, Copy, Debug)]
pub struct InputSpan {
    pub start: u64,
    pub end: u64,
    pub mask: u16,
}

pub struct Bus {
    pub rom: Vec<u8>,
    pub wram: Vec<u8>,
    pub sram: Vec<u8>,
    pub ppu: Ppu,
    pub apu: Apu,
    pub dsp_on: bool,
    pub audio: Option<Vec<i16>>,

    pub mdr: u8,
    pub clock: u64,
    pub line_start: u64,
    pub vline: u16,
    pub frame: u64,
    pub next_event: u64,
    refresh_done: bool,
    hdma_done: bool,
    irq_done: bool,
    irq_pos: u64,

    pub nmitimen: u8,
    wrio: u8,
    wrmpya: u8,
    wrdiv: u16,
    rddiv: u16,
    rdmpy: u16,
    htime: u16,
    vtime: u16,
    pub hdmaen: u8,
    memsel: u8,
    rom_speed: u64,

    pub rdnmi: bool,
    pub nmi_pending: bool,
    pub irq_flag: bool,

    // Joypads.
    pub inputs: Vec<InputSpan>,
    pub pad: u16,
    joy1: u16,
    joy_busy_until: u64,
    joy_strobe: bool,
    joy_shift: [u16; 2],
    joy_bits: [u8; 2],

    pub dma: [Channel; 8],
    wram_port: u32,

    /// Set at the start of line 225; the run loop takes the snapshot and
    /// clears it before the NMI is serviced.
    pub vblank_event: bool,
    /// Set when line 0 begins: vblank, and the NMI's uploads, are over.
    pub frame_start_event: bool,
    /// Composed `$2100-$2133` values as each visible line 1-224 began.
    pub line_regs: Vec<[u16; NREGS]>,
    /// Registers HDMA wrote this frame (bit n = `$2100+n`).
    pub hdma_touched: u64,

    /// PC of the instruction being executed (for logs).
    pub op_pc: u32,
    /// `--watch-write` ranges, as WRAM indices, and their log.
    pub watch: Vec<(usize, usize)>,
    pub watch_log: Option<std::io::BufWriter<std::fs::File>>,
    pub xfer_log: Option<XferLog>,
    pub apu_log: Option<BufWriter<File>>,
    apu_last_read: [u16; 4],

    // Statistics.
    pub nmi_count: u64,
    pub dma_count: u64,
    pub dma_bytes: u64,
    pub hdma_lines: u64,
}

impl Bus {
    pub fn new(rom: Vec<u8>) -> Self {
        let mut apu = Apu::new();
        apu.reset();
        let mut b = Self {
            rom,
            wram: vec![0; 0x20000],
            sram: vec![0; 0x2000],
            ppu: Ppu::new(),
            apu,
            dsp_on: true,
            audio: None,
            mdr: 0,
            clock: 0,
            line_start: 0,
            vline: 0,
            frame: 0,
            next_event: 0,
            refresh_done: false,
            hdma_done: false,
            irq_done: true,
            irq_pos: u64::MAX,
            nmitimen: 0,
            wrio: 0xFF,
            wrmpya: 0xFF,
            wrdiv: 0xFFFF,
            rddiv: 0,
            rdmpy: 0,
            htime: 0x1FF,
            vtime: 0x1FF,
            hdmaen: 0,
            memsel: 0,
            rom_speed: 8,
            rdnmi: false,
            nmi_pending: false,
            irq_flag: false,
            inputs: Vec::new(),
            pad: 0,
            joy1: 0,
            joy_busy_until: 0,
            joy_strobe: false,
            joy_shift: [0; 2],
            joy_bits: [0; 2],
            dma: [Channel::default(); 8],
            wram_port: 0,
            vblank_event: false,
            frame_start_event: false,
            line_regs: vec![[0; NREGS]; 224],
            hdma_touched: 0,
            op_pc: 0,
            watch: Vec::new(),
            watch_log: None,
            xfer_log: None,
            apu_log: None,
            apu_last_read: [0xFFFF; 4],
            nmi_count: 0,
            dma_count: 0,
            dma_bytes: 0,
            hdma_lines: 0,
        };
        for ch in b.dma.iter_mut() {
            ch.dmap = 0xFF;
            ch.bbad = 0xFF;
            ch.a1t = 0xFFFF;
            ch.a1b = 0xFF;
            ch.das = 0xFFFF;
            ch.dasb = 0xFF;
            ch.a2a = 0xFFFF;
            ch.ntrl = 0xFF;
            ch.unused = 0xFF;
        }
        b.hdma_init();
        b.compute_next_event();
        b
    }

    #[inline]
    pub fn hpos(&self) -> u64 {
        self.clock - self.line_start
    }

    /// PPU dot (0-339) for `$2137`; 1364 cycles map to 340 dots of 4 with
    /// the two long dots ignored.
    fn hdot(&self) -> u16 {
        (self.hpos() / 4).min(339) as u16
    }

    // --- memory map ----------------------------------------------------

    #[inline]
    fn rom_index(&self, bank: u32, off: u32) -> usize {
        (((bank & 0x7F) * 0x8000 + (off - 0x8000)) as usize) % self.rom.len()
    }

    /// Master cycles for one CPU access to `addr` (fullsnes "SNES Memory Speed").
    #[inline]
    fn speed(&self, addr: u32) -> u64 {
        let bank = addr >> 16;
        let off = addr & 0xFFFF;
        if bank & 0x40 == 0 {
            if off & 0x8000 != 0 {
                return if bank & 0x80 != 0 { self.rom_speed } else { 8 };
            }
            if off < 0x2000 {
                8
            } else if off < 0x4000 {
                6
            } else if off < 0x4200 {
                12
            } else if off < 0x6000 {
                6
            } else {
                8
            }
        } else if bank & 0x80 != 0 {
            self.rom_speed
        } else {
            8
        }
    }

    /// Side-effect-free read of plain memory (ROM, WRAM, SRAM); I/O reads 0.
    pub fn peek(&self, addr: u32) -> u8 {
        let bank = (addr >> 16) & 0xFF;
        let off = addr & 0xFFFF;
        if bank == 0x7E || bank == 0x7F {
            return self.wram[(addr - 0x7E_0000) as usize];
        }
        if off >= 0x8000 {
            return self.rom[self.rom_index(bank, off)];
        }
        if bank & 0x40 == 0 {
            if off < 0x2000 {
                return self.wram[off as usize];
            }
            return 0;
        }
        if (0x70..=0x7D).contains(&(bank & 0x7F)) {
            return self.sram[(off & 0x1FFF) as usize];
        }
        0
    }

    /// CPU read: charges the access time, then reads.
    #[inline]
    pub fn read(&mut self, addr: u32) -> u8 {
        self.clock += self.speed(addr);
        let v = self.read_raw(addr, false);
        self.mdr = v;
        v
    }

    #[inline]
    pub fn write(&mut self, addr: u32, v: u8) {
        self.clock += self.speed(addr);
        self.mdr = v;
        if !self.watch.is_empty() {
            self.check_watch(addr, v);
        }
        self.write_raw(addr, v, false);
    }

    /// `--watch-write`: log a CPU write into a watched WRAM byte when it
    /// changes the byte, with the instruction that made it.
    fn check_watch(&mut self, addr: u32, v: u8) {
        let bank = (addr >> 16) & 0xFF;
        let off = addr & 0xFFFF;
        let idx = if bank == 0x7E || bank == 0x7F {
            (addr - 0x7E_0000) as usize
        } else if bank & 0x40 == 0 && off < 0x2000 {
            off as usize
        } else {
            return;
        };
        if !self.watch.iter().any(|&(lo, hi)| (lo..=hi).contains(&idx)) {
            return;
        }
        let old = self.wram[idx];
        if old == v {
            return;
        }
        let (frame, line, pc) = (self.frame, self.vline, self.op_pc);
        if let Some(f) = self.watch_log.as_mut() {
            use std::io::Write;
            let _ = writeln!(
                f,
                "{frame}\t{line}\t${:02X}:{:04X}\t$7E:{idx:04X}\t{old:02X}\t{v:02X}",
                pc >> 16,
                pc & 0xFFFF
            );
        }
    }

    /// One internal CPU cycle.
    #[inline]
    pub fn idle(&mut self) {
        self.clock += 6;
    }

    /// Read with side effects but no timing. `dma` is true for A-bus
    /// accesses by the DMA unit, which cannot see the B-bus or DMA registers.
    fn read_raw(&mut self, addr: u32, dma: bool) -> u8 {
        let bank = (addr >> 16) & 0xFF;
        let off = addr & 0xFFFF;
        if bank == 0x7E || bank == 0x7F {
            return self.wram[(addr - 0x7E_0000) as usize];
        }
        if off >= 0x8000 {
            return self.rom[self.rom_index(bank, off)];
        }
        if bank & 0x40 == 0 {
            if off < 0x2000 {
                return self.wram[off as usize];
            }
            if (0x2100..0x2200).contains(&off) {
                if dma {
                    return self.mdr;
                }
                return self.read_b((off & 0xFF) as u8);
            }
            if off == 0x4016 || off == 0x4017 {
                return self.read_joyser((off & 1) as usize);
            }
            if (0x4200..0x4400).contains(&off) {
                if dma && (off >= 0x4300 || off == 0x420B || off == 0x420C) {
                    return self.mdr;
                }
                return self.read_cpu_io(off);
            }
            return self.mdr;
        }
        if (0x70..=0x7D).contains(&(bank & 0x7F)) {
            return self.sram[(off & 0x1FFF) as usize];
        }
        self.mdr
    }

    fn write_raw(&mut self, addr: u32, v: u8, dma: bool) {
        let bank = (addr >> 16) & 0xFF;
        let off = addr & 0xFFFF;
        if bank == 0x7E || bank == 0x7F {
            self.wram[(addr - 0x7E_0000) as usize] = v;
            return;
        }
        if off >= 0x8000 {
            return; // ROM
        }
        if bank & 0x40 == 0 {
            if off < 0x2000 {
                self.wram[off as usize] = v;
            } else if (0x2100..0x2200).contains(&off) {
                if !dma {
                    self.write_b((off & 0xFF) as u8, v, "cpu", -1, 0);
                }
            } else if off == 0x4016 {
                self.write_joyser(v);
            } else if (0x4200..0x4400).contains(&off) && !dma {
                self.write_cpu_io(off, v);
            }
            return;
        }
        if (0x70..=0x7D).contains(&(bank & 0x7F)) {
            self.sram[(off & 0x1FFF) as usize] = v;
        }
    }

    // --- B bus -------------------------------------------------------------

    fn display_active(&self) -> bool {
        !self.ppu.forced_blank() && self.vline < VBLANK_LINE
    }

    fn read_b(&mut self, reg: u8) -> u8 {
        match reg {
            0x34..=0x3F => {
                let (h, v) = (self.hdot(), self.vline);
                let open = self.mdr;
                let wrio7 = self.wrio & 0x80 != 0;
                self.ppu.read(reg, open, h, v, wrio7)
            }
            0x40..=0x7F => {
                self.sync_apu();
                let p = usize::from(reg & 3);
                let v = self.apu.port_out[p];
                if self.apu_last_read[p] != u16::from(v) {
                    self.apu_last_read[p] = u16::from(v);
                    self.log_apu('R', p, v);
                }
                v
            }
            0x80 => {
                let v = self.wram[self.wram_port as usize];
                self.wram_port = (self.wram_port + 1) & 0x1FFFF;
                v
            }
            _ => self.mdr,
        }
    }

    /// Write `$2100+reg`. `kind`/`ch`/`src` describe who wrote it, for the
    /// transfer log and the HDMA register capture.
    fn write_b(&mut self, reg: u8, v: u8, kind: &'static str, ch: i8, src: u32) {
        match reg {
            0x00..=0x3F => {
                let active = self.display_active();
                if let Some(pw) = self.ppu.write(reg, v, active) {
                    if self.xfer_log.is_some() {
                        self.log_port(kind, ch, src, reg, pw);
                    }
                }
            }
            0x40..=0x7F => {
                self.sync_apu();
                let p = usize::from(reg & 3);
                self.apu.port_in[p] = v;
                self.log_apu('W', p, v);
            }
            0x80 => {
                self.wram[self.wram_port as usize] = v;
                self.wram_port = (self.wram_port + 1) & 0x1FFFF;
            }
            0x81 => self.wram_port = (self.wram_port & 0x1FF00) | u32::from(v),
            0x82 => self.wram_port = (self.wram_port & 0x100FF) | (u32::from(v) << 8),
            0x83 => self.wram_port = (self.wram_port & 0x0FFFF) | (u32::from(v & 1) << 16),
            _ => {}
        }
    }

    fn log_port(&mut self, kind: &'static str, ch: i8, src: u32, reg: u8, pw: PortWrite) {
        let (frame, line, pc, vmain) = (self.frame, self.vline, self.op_pc, self.ppu.vmain);
        let mode = if ch >= 0 {
            self.dma[ch as usize].dmap & 7
        } else {
            0
        };
        let log = match self.xfer_log.as_mut() {
            Some(l) => l,
            None => return,
        };
        let has_src = kind != "cpu";
        if let Some(r) = log.run.as_mut() {
            let same = r.frame == frame
                && r.kind == kind
                && r.ch == ch
                && r.pc == pc
                && r.target == pw.target
                && (kind != "hdma" || r.line + 1 >= line);
            if same {
                r.bytes += 1;
                r.dest_last = pw.addr;
                r.dropped += u32::from(pw.dropped);
                if has_src {
                    r.src_last = src;
                }
                if kind == "hdma" {
                    r.line = r.line.max(line);
                }
                return;
            }
        }
        log.flush_run();
        log.run = Some(Run {
            frame,
            line,
            kind,
            ch,
            pc,
            src_start: src,
            src_last: src,
            has_src,
            target: pw.target,
            dest_start: pw.addr,
            dest_last: pw.addr,
            bytes: 1,
            dropped: u32::from(pw.dropped),
            mode,
            bbad: reg,
            vmain,
        });
    }

    fn log_apu(&mut self, dir: char, port: usize, v: u8) {
        let (frame, line, pc) = (self.frame, self.vline, self.op_pc);
        if let Some(out) = self.apu_log.as_mut() {
            let _ = writeln!(
                out,
                "{}\t{}\t{}\t{}\t{}\t${:02X}",
                frame,
                line,
                fmt_snes(pc),
                dir,
                port,
                v
            );
        }
    }

    /// Bring the SPC700 up to the S-CPU's time (1.024 MHz vs 21.47727 MHz).
    pub fn sync_apu(&mut self) {
        let target = (u128::from(self.clock) * SPC_HZ / MASTER_HZ) as u64;
        let dsp = self.dsp_on;
        self.apu.run_until(target, dsp, self.audio.as_mut());
    }

    // --- joypads -----------------------------------------------------------

    fn pad_for_frame(&self, frame: u64) -> u16 {
        self.inputs
            .iter()
            .filter(|s| s.start <= frame && frame < s.end)
            .fold(0, |m, s| m | s.mask)
    }

    fn write_joyser(&mut self, v: u8) {
        let strobe = v & 1 != 0;
        if strobe {
            self.joy_shift = [self.pad, 0];
            self.joy_bits = [0, 0];
        }
        self.joy_strobe = strobe;
    }

    fn read_joyser(&mut self, port: usize) -> u8 {
        let bit = if self.joy_strobe {
            u8::from(port == 0 && self.pad & 0x8000 != 0)
        } else if self.joy_bits[port] >= 16 {
            1
        } else {
            let b = u8::from(self.joy_shift[port] & 0x8000 != 0);
            self.joy_shift[port] <<= 1;
            self.joy_bits[port] += 1;
            b
        };
        let fixed = if port == 1 { 0x1C } else { 0 };
        (self.mdr & 0xE0) | fixed | bit
    }

    // --- CPU I/O ------------------------------------------------------------

    fn read_cpu_io(&mut self, off: u32) -> u8 {
        match off {
            0x4210 => {
                let v = (u8::from(self.rdnmi) << 7) | (self.mdr & 0x70) | 0x02;
                self.rdnmi = false;
                v
            }
            0x4211 => {
                let v = (u8::from(self.irq_flag) << 7) | (self.mdr & 0x7F);
                self.irq_flag = false;
                v
            }
            0x4212 => {
                let h = self.hpos();
                let vb = self.vline >= VBLANK_LINE;
                let hb = !(4..1096).contains(&h);
                let busy = self.clock < self.joy_busy_until;
                (u8::from(vb) << 7) | (u8::from(hb) << 6) | (self.mdr & 0x3E) | u8::from(busy)
            }
            0x4213 => self.wrio,
            0x4214 => self.rddiv as u8,
            0x4215 => (self.rddiv >> 8) as u8,
            0x4216 => self.rdmpy as u8,
            0x4217 => (self.rdmpy >> 8) as u8,
            0x4218 => self.joy1 as u8,
            0x4219 => (self.joy1 >> 8) as u8,
            0x421A..=0x421F => 0,
            0x4300..=0x437F => {
                let c = &self.dma[((off >> 4) & 7) as usize];
                match off & 0xF {
                    0x0 => c.dmap,
                    0x1 => c.bbad,
                    0x2 => c.a1t as u8,
                    0x3 => (c.a1t >> 8) as u8,
                    0x4 => c.a1b,
                    0x5 => c.das as u8,
                    0x6 => (c.das >> 8) as u8,
                    0x7 => c.dasb,
                    0x8 => c.a2a as u8,
                    0x9 => (c.a2a >> 8) as u8,
                    0xA => c.ntrl,
                    0xB | 0xF => c.unused,
                    _ => self.mdr,
                }
            }
            _ => self.mdr,
        }
    }

    fn write_cpu_io(&mut self, off: u32, v: u8) {
        match off {
            0x4200 => {
                let was = self.nmitimen;
                self.nmitimen = v;
                // fullsnes: NMI fires when "[4200h].7 AND [4210h].7" goes 0->1.
                if was & 0x80 == 0 && v & 0x80 != 0 && self.rdnmi {
                    self.nmi_pending = true;
                }
                if v & 0x30 == 0 {
                    self.irq_flag = false;
                }
                self.update_irq_pos(true);
            }
            0x4201 => {
                if self.wrio & 0x80 != 0 && v & 0x80 == 0 {
                    let (h, l) = (self.hdot(), self.vline);
                    self.ppu.latch_counters(h, l);
                }
                self.wrio = v;
            }
            0x4202 => self.wrmpya = v,
            0x4203 => {
                self.rdmpy = u16::from(self.wrmpya) * u16::from(v);
                self.rddiv = u16::from(v);
            }
            0x4204 => self.wrdiv = (self.wrdiv & 0xFF00) | u16::from(v),
            0x4205 => self.wrdiv = (self.wrdiv & 0x00FF) | (u16::from(v) << 8),
            0x4206 => {
                if v == 0 {
                    self.rddiv = 0xFFFF;
                    self.rdmpy = self.wrdiv;
                } else {
                    self.rddiv = self.wrdiv / u16::from(v);
                    self.rdmpy = self.wrdiv % u16::from(v);
                }
            }
            0x4207 => {
                self.htime = (self.htime & 0x100) | u16::from(v);
                self.update_irq_pos(true);
            }
            0x4208 => {
                self.htime = (self.htime & 0xFF) | (u16::from(v & 1) << 8);
                self.update_irq_pos(true);
            }
            0x4209 => {
                self.vtime = (self.vtime & 0x100) | u16::from(v);
                self.update_irq_pos(true);
            }
            0x420A => {
                self.vtime = (self.vtime & 0xFF) | (u16::from(v & 1) << 8);
                self.update_irq_pos(true);
            }
            0x420B => self.run_dma(v),
            0x420C => self.hdmaen = v,
            0x420D => {
                self.memsel = v;
                self.rom_speed = if v & 1 != 0 { 6 } else { 8 };
            }
            0x4300..=0x437F => {
                let c = &mut self.dma[((off >> 4) & 7) as usize];
                match off & 0xF {
                    0x0 => c.dmap = v,
                    0x1 => c.bbad = v,
                    0x2 => c.a1t = (c.a1t & 0xFF00) | u16::from(v),
                    0x3 => c.a1t = (c.a1t & 0x00FF) | (u16::from(v) << 8),
                    0x4 => c.a1b = v,
                    0x5 => c.das = (c.das & 0xFF00) | u16::from(v),
                    0x6 => c.das = (c.das & 0x00FF) | (u16::from(v) << 8),
                    0x7 => c.dasb = v,
                    0x8 => c.a2a = (c.a2a & 0xFF00) | u16::from(v),
                    0x9 => c.a2a = (c.a2a & 0x00FF) | (u16::from(v) << 8),
                    0xA => c.ntrl = v,
                    0xB | 0xF => c.unused = v,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    // --- DMA / HDMA -------------------------------------------------------------

    /// General-purpose DMA (`$420B`), channels in order 0-7, 8 master cycles
    /// per byte plus 8 per channel and a fixed overhead.
    fn run_dma(&mut self, mask: u8) {
        if mask == 0 {
            return;
        }
        self.clock += 18;
        for ch in 0..8usize {
            if mask & (1 << ch) == 0 {
                continue;
            }
            self.clock += 8;
            self.dma_count += 1;
            let c = self.dma[ch];
            let mode = usize::from(c.dmap & 7);
            let b_to_a = c.dmap & 0x80 != 0;
            let step: u16 = match (c.dmap >> 3) & 3 {
                0 => 1,
                2 => 0xFFFF,
                _ => 0,
            };
            let mut a = c.a1t;
            let mut count: u32 = if c.das == 0 {
                0x10000
            } else {
                u32::from(c.das)
            };
            let mut i = 0usize;
            if let Some(l) = self.xfer_log.as_mut() {
                l.flush_run();
            }
            while count > 0 {
                let breg = c.bbad.wrapping_add(UNIT[mode][i & 3]);
                let addr = (u32::from(c.a1b) << 16) | u32::from(a);
                if b_to_a {
                    let v = self.read_b(breg);
                    self.write_raw(addr, v, true);
                } else {
                    let v = self.read_raw(addr, true);
                    self.write_b(breg, v, "dma", ch as i8, addr);
                }
                self.clock += 8;
                a = a.wrapping_add(step);
                count -= 1;
                i += 1;
                self.dma_bytes += 1;
                if self.clock >= self.next_event {
                    self.run_events();
                }
            }
            if let Some(l) = self.xfer_log.as_mut() {
                l.flush_run();
            }
            self.dma[ch].a1t = a;
            self.dma[ch].das = 0;
        }
    }

    fn hdma_read(&mut self, addr: u32) -> u8 {
        self.clock += 8;
        self.read_raw(addr, true)
    }

    /// bsnes `hdmaReload`: fetch the next line count (and indirect pointer)
    /// once the 7-bit counter has run out.
    fn hdma_reload(&mut self, ch: usize) {
        let c = self.dma[ch];
        let data = self.hdma_read((u32::from(c.a1b) << 16) | u32::from(c.a2a));
        if c.ntrl & 0x7F == 0 {
            let mut c = c;
            c.ntrl = data;
            c.a2a = c.a2a.wrapping_add(1);
            c.hdma_completed = c.ntrl == 0;
            c.hdma_do_transfer = !c.hdma_completed;
            if c.dmap & 0x40 != 0 {
                let lo = self.hdma_read((u32::from(c.a1b) << 16) | u32::from(c.a2a));
                c.a2a = c.a2a.wrapping_add(1);
                let hi = self.hdma_read((u32::from(c.a1b) << 16) | u32::from(c.a2a));
                c.a2a = c.a2a.wrapping_add(1);
                c.das = u16::from_le_bytes([lo, hi]);
            }
            self.dma[ch] = c;
        }
    }

    /// Line 0: reload every enabled channel's table pointer.
    fn hdma_init(&mut self) {
        for c in self.dma.iter_mut() {
            c.hdma_do_transfer = true;
            c.hdma_completed = false;
        }
        if self.hdmaen == 0 {
            return;
        }
        self.clock += 18;
        for ch in 0..8 {
            if self.hdmaen & (1 << ch) == 0 {
                continue;
            }
            self.dma[ch].a2a = self.dma[ch].a1t;
            self.dma[ch].ntrl = 0;
            self.hdma_reload(ch);
        }
    }

    fn hdma_active(&self, ch: usize) -> bool {
        self.hdmaen & (1 << ch) != 0 && !self.dma[ch].hdma_completed
    }

    /// One HDMA step (H=278 on lines 0-224): transfer, then advance.
    fn hdma_run(&mut self) {
        if (0..8).all(|ch| !self.hdma_active(ch)) {
            return;
        }
        self.clock += 18;
        self.hdma_lines += 1;
        for ch in 0..8usize {
            if !self.hdma_active(ch) {
                continue;
            }
            self.clock += 8;
            let c = self.dma[ch];
            if !c.hdma_do_transfer {
                continue;
            }
            let mode = usize::from(c.dmap & 7);
            let indirect = c.dmap & 0x40 != 0;
            let mut a2a = c.a2a;
            let mut das = c.das;
            for i in 0..usize::from(UNIT_LEN[mode]) {
                let addr = if indirect {
                    let a = (u32::from(c.dasb) << 16) | u32::from(das);
                    das = das.wrapping_add(1);
                    a
                } else {
                    let a = (u32::from(c.a1b) << 16) | u32::from(a2a);
                    a2a = a2a.wrapping_add(1);
                    a
                };
                let breg = c.bbad.wrapping_add(UNIT[mode][i]);
                self.clock += 8;
                if c.dmap & 0x80 != 0 {
                    let v = self.read_b(breg);
                    self.write_raw(addr, v, true);
                } else {
                    let v = self.read_raw(addr, true);
                    if usize::from(breg) < NREGS && !matches!(breg, 0x04 | 0x18 | 0x19 | 0x22) {
                        self.hdma_touched |= 1 << breg;
                    }
                    self.write_b(breg, v, "hdma", ch as i8, addr);
                }
            }
            self.dma[ch].a2a = a2a;
            self.dma[ch].das = das;
        }
        for ch in 0..8usize {
            if !self.hdma_active(ch) {
                continue;
            }
            let n = self.dma[ch].ntrl.wrapping_sub(1);
            self.dma[ch].ntrl = n;
            self.dma[ch].hdma_do_transfer = n & 0x80 != 0;
            self.hdma_reload(ch);
        }
    }

    // --- scanline clock -------------------------------------------------------

    fn update_irq_pos(&mut self, midline: bool) {
        let hpos = u64::from(self.htime) * 4 + 14;
        let pos = match (self.nmitimen >> 4) & 3 {
            0 => u64::MAX,
            1 => hpos,
            2 => {
                if self.vline == self.vtime {
                    10
                } else {
                    u64::MAX
                }
            }
            _ => {
                if self.vline == self.vtime {
                    hpos
                } else {
                    u64::MAX
                }
            }
        };
        self.irq_pos = if pos >= LINE_CYCLES { u64::MAX } else { pos };
        self.irq_done = self.irq_pos == u64::MAX || (midline && self.irq_pos <= self.hpos());
        self.compute_next_event();
    }

    pub fn compute_next_event(&mut self) {
        let mut n = LINE_CYCLES;
        if !self.refresh_done {
            n = n.min(REFRESH_POS);
        }
        if !self.hdma_done {
            n = n.min(HDMA_POS);
        }
        if !self.irq_done {
            n = n.min(self.irq_pos);
        }
        self.next_event = self.line_start + n;
    }

    /// Process every event whose time has come.
    pub fn run_events(&mut self) {
        loop {
            let h = self.hpos();
            if !self.irq_done && h >= self.irq_pos {
                self.irq_done = true;
                self.irq_flag = true;
                continue;
            }
            if !self.refresh_done && h >= REFRESH_POS {
                self.refresh_done = true;
                self.clock += 40;
                continue;
            }
            if !self.hdma_done && h >= HDMA_POS {
                self.hdma_done = true;
                if self.vline < VBLANK_LINE && self.hdmaen != 0 {
                    self.hdma_run();
                }
                continue;
            }
            if h >= LINE_CYCLES {
                self.new_line();
                continue;
            }
            break;
        }
        self.compute_next_event();
    }

    fn new_line(&mut self) {
        self.line_start += LINE_CYCLES;
        self.vline += 1;
        self.refresh_done = false;
        self.hdma_done = false;
        if self.vline == LINES {
            self.vline = 0;
            self.frame += 1;
            self.rdnmi = false;
            self.hdma_touched = 0;
            self.hdma_init();
            self.frame_start_event = true;
        }
        if (1..=224).contains(&self.vline) {
            self.line_regs[usize::from(self.vline) - 1] = self.ppu.cur;
        }
        if self.vline == VBLANK_LINE {
            self.rdnmi = true;
            if self.nmitimen & 0x80 != 0 {
                self.nmi_pending = true;
            }
            self.ppu.vblank_oam_reload();
            self.pad = self.pad_for_frame(self.frame);
            if self.nmitimen & 1 != 0 {
                self.joy1 = self.pad;
                self.joy_busy_until = self.line_start + 130 + 4224;
            }
            self.vblank_event = true;
            self.sync_apu();
        }
        self.update_irq_pos(false);
    }

    /// WAI: let time pass to the next event.
    pub fn idle_until_event(&mut self) {
        if self.clock < self.next_event {
            self.clock = self.next_event;
        }
        self.run_events();
    }

    // --- save state -------------------------------------------------------------

    pub fn save(&self, w: &mut crate::state::Writer) {
        w.bytes(&self.wram);
        w.bytes(&self.sram);
        self.ppu.save(w);
        self.apu.save(w);
        w.u8(self.mdr);
        w.u64(self.clock);
        w.u64(self.line_start);
        w.u16(self.vline);
        w.u64(self.frame);
        w.bool(self.refresh_done);
        w.bool(self.hdma_done);
        w.u8(self.nmitimen);
        w.u8(self.wrio);
        w.u8(self.wrmpya);
        w.u16(self.wrdiv);
        w.u16(self.rddiv);
        w.u16(self.rdmpy);
        w.u16(self.htime);
        w.u16(self.vtime);
        w.u8(self.hdmaen);
        w.u8(self.memsel);
        w.bool(self.rdnmi);
        w.bool(self.nmi_pending);
        w.bool(self.irq_flag);
        w.u16(self.joy1);
        w.u64(self.joy_busy_until);
        for c in &self.dma {
            for v in [c.dmap, c.bbad, c.a1b, c.dasb, c.ntrl, c.unused] {
                w.u8(v);
            }
            w.u16(c.a1t);
            w.u16(c.das);
            w.u16(c.a2a);
            w.bool(c.hdma_completed);
            w.bool(c.hdma_do_transfer);
        }
        w.u32(self.wram_port);
        w.u64(self.hdma_touched);
        for l in &self.line_regs {
            for &v in l.iter() {
                w.u16(v);
            }
        }
        w.u64(self.nmi_count);
    }

    pub fn load(&mut self, r: &mut crate::state::Reader) {
        r.bytes(&mut self.wram);
        r.bytes(&mut self.sram);
        self.ppu.load(r);
        self.apu.load(r);
        self.mdr = r.u8();
        self.clock = r.u64();
        self.line_start = r.u64();
        self.vline = r.u16();
        self.frame = r.u64();
        self.refresh_done = r.bool();
        self.hdma_done = r.bool();
        self.nmitimen = r.u8();
        self.wrio = r.u8();
        self.wrmpya = r.u8();
        self.wrdiv = r.u16();
        self.rddiv = r.u16();
        self.rdmpy = r.u16();
        self.htime = r.u16();
        self.vtime = r.u16();
        self.hdmaen = r.u8();
        self.memsel = r.u8();
        self.rom_speed = if self.memsel & 1 != 0 { 6 } else { 8 };
        self.rdnmi = r.bool();
        self.nmi_pending = r.bool();
        self.irq_flag = r.bool();
        self.joy1 = r.u16();
        self.joy_busy_until = r.u64();
        for c in self.dma.iter_mut() {
            c.dmap = r.u8();
            c.bbad = r.u8();
            c.a1b = r.u8();
            c.dasb = r.u8();
            c.ntrl = r.u8();
            c.unused = r.u8();
            c.a1t = r.u16();
            c.das = r.u16();
            c.a2a = r.u16();
            c.hdma_completed = r.bool();
            c.hdma_do_transfer = r.bool();
        }
        self.wram_port = r.u32();
        self.hdma_touched = r.u64();
        for l in self.line_regs.iter_mut() {
            for v in l.iter_mut() {
                *v = r.u16();
            }
        }
        self.nmi_count = r.u64();
        let midline = true;
        self.update_irq_pos(midline);
    }
}
