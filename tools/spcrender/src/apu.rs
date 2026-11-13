//! The audio processing unit as one machine: 64 KB of RAM, the I/O page at
//! `$F0-$FF`, three timers, the CPU registers (the instruction set itself is
//! in `cpu.rs`) and the DSP.
//!
//! Timing model: the CPU runs whole instructions; after each one the timers
//! advance by its cycle count, and every 32 cycles the DSP produces one
//! stereo sample. DSP register accesses are therefore resolved to within one
//! instruction (at most 12 cycles, 0.4 of a sample) rather than to the exact
//! cycle. The one access that is placed more finely is a read of a timer
//! output: the timers are first brought up to the instruction's last cycle,
//! which is where a load's memory read sits, because the N-SPC main loop
//! turns that count straight into tempo. See docs/audio.md, "Rendering", for
//! what the model does and does not affect.

use std::fmt;

use crate::dsp::Dsp;
use crate::tables::{CYCLES, IPL_ROM};

/// CPU cycles per output sample: 1.024 MHz / 32 kHz.
pub const CYCLES_PER_SAMPLE: u64 = 32;

const SPC_MAGIC: &[u8] = b"SNES-SPC700 Sound File Data";
const SPC_RAM_OFFSET: usize = 0x100;
const SPC_DSP_OFFSET: usize = 0x10100;
const SPC_EXTRA_OFFSET: usize = 0x101C0;
const SPC_MIN_SIZE: usize = 0x10180;
const IPL_BASE: usize = 0xFFC0;

/// What can go wrong reading a `.spc` image.
#[derive(Debug)]
pub enum SpcError {
    TooShort(usize),
    BadMagic,
}

impl fmt::Display for SpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpcError::TooShort(n) => write!(
                f,
                "file is {n} bytes; a .spc needs at least {SPC_MIN_SIZE} \
                 (header, 64 KB RAM, 128 DSP registers)"
            ),
            SpcError::BadMagic => write!(f, "missing the 'SNES-SPC700 Sound File Data' signature"),
        }
    }
}

/// Play length from the ID666 text tag, when the header carries one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Id666Length {
    pub seconds: u32,
    pub fade_ms: u32,
}

/// One of the three interval timers.
///
/// A fixed prescaler divides the CPU clock (by 128 for timers 0 and 1, by 16
/// for timer 2). While the timer is enabled each prescaler tick advances an
/// 8-bit divider; when the divider reaches the target written to
/// `$FA-$FC` (0 meaning 256) it resets and the 4-bit output counter that the
/// program reads at `$FD-$FF` goes up by one.
#[derive(Debug, Clone, Copy)]
struct Timer {
    prescale: u32,
    phase: u32,
    enabled: bool,
    target: u8,
    divider: u8,
    out: u8,
}

impl Timer {
    const fn new(prescale: u32) -> Self {
        Self {
            prescale,
            phase: 0,
            enabled: false,
            target: 0,
            divider: 0,
            out: 0,
        }
    }

    fn advance(&mut self, cycles: u32) {
        self.phase += cycles;
        while self.phase >= self.prescale {
            self.phase -= self.prescale;
            if !self.enabled {
                continue;
            }
            self.divider = self.divider.wrapping_add(1);
            if self.divider == self.target {
                self.divider = 0;
                self.out = (self.out + 1) & 0x0F;
            }
        }
    }
}

/// A write to a watched RAM address, for `--watch`.
#[derive(Debug, Clone, Copy)]
pub struct WatchHit {
    pub sample: u64,
    pub addr: u16,
    pub value: u8,
    pub pc: u16,
}

pub struct Apu {
    pub ram: Box<[u8; 0x10000]>,
    pub dsp: Dsp,

    // CPU registers.
    pub pc: u16,
    pub a: u8,
    pub x: u8,
    pub y: u8,
    pub sp: u8,
    pub psw: u8,
    /// Set by SLEEP/STOP. Nothing on this board can wake the CPU again.
    pub halted: bool,

    rom_enabled: bool,
    dsp_addr: u8,
    /// What the program reads at `$F4-$F7`: the latches the S-CPU writes.
    /// Nothing drives them here, so they hold the values from the image.
    port_in: [u8; 4],
    /// What the program wrote to `$F4-$F7`, as the S-CPU would read it.
    pub port_out: [u8; 4],
    timers: [Timer; 3],

    /// CPU cycles executed.
    pub clock: u64,
    next_sample_clock: u64,
    /// Samples produced so far.
    pub sample_index: u64,
    pub instructions: u64,
    /// One bit per opcode that has been executed.
    pub opcodes_seen: [u64; 4],
    /// Address of the opcode being executed, for watch reports.
    pub(crate) op_pc: u16,
    /// The opcode being executed.
    pub(crate) op: u8,
    /// Cycles of the current instruction the timers have already been given.
    timer_lead: u32,
    /// Instructions still to be printed by `--trace`.
    pub trace_left: u64,

    watch: Vec<u16>,
    pub watch_hits: Vec<WatchHit>,
}

impl Apu {
    /// A machine with empty RAM and the CPU parked at `$0000`.
    pub fn new() -> Self {
        Self {
            ram: Box::new([0; 0x10000]),
            dsp: Dsp::new(),
            pc: 0,
            a: 0,
            x: 0,
            y: 0,
            sp: 0xEF,
            psw: 0,
            halted: false,
            rom_enabled: false,
            dsp_addr: 0,
            port_in: [0; 4],
            port_out: [0; 4],
            timers: [Timer::new(128), Timer::new(128), Timer::new(16)],
            clock: 0,
            next_sample_clock: CYCLES_PER_SAMPLE,
            sample_index: 0,
            instructions: 0,
            opcodes_seen: [0; 4],
            op_pc: 0,
            op: 0,
            timer_lead: 0,
            trace_left: 0,
            watch: Vec::new(),
            watch_hits: Vec::new(),
        }
    }

    /// Build a machine from a `.spc` image (v0.30 layout: 0x100-byte header
    /// with the CPU registers at 0x25, RAM at 0x100, the 128 DSP registers at
    /// 0x10100, and the 64 bytes of RAM hidden under the boot ROM at 0x101C0).
    ///
    /// # Errors
    ///
    /// Fails if the buffer is too short or lacks the format signature.
    pub fn from_spc(data: &[u8]) -> Result<Self, SpcError> {
        if data.len() < SPC_MIN_SIZE {
            return Err(SpcError::TooShort(data.len()));
        }
        if !data.starts_with(SPC_MAGIC) {
            return Err(SpcError::BadMagic);
        }
        let mut apu = Self::new();
        apu.pc = u16::from_le_bytes([data[0x25], data[0x26]]);
        apu.a = data[0x27];
        apu.x = data[0x28];
        apu.y = data[0x29];
        apu.psw = data[0x2A];
        apu.sp = data[0x2B];
        apu.ram
            .copy_from_slice(&data[SPC_RAM_OFFSET..SPC_RAM_OFFSET + 0x10000]);

        // The I/O page of the dump is the register state, not RAM contents.
        let control = apu.ram[0xF1];
        apu.rom_enabled = control & 0x80 != 0;
        apu.dsp_addr = apu.ram[0xF2];
        apu.port_in.copy_from_slice(&apu.ram[0xF4..0xF8]);
        for (i, timer) in apu.timers.iter_mut().enumerate() {
            timer.enabled = control & (1 << i) != 0;
            timer.target = apu.ram[0xFA + i];
            timer.out = apu.ram[0xFD + i] & 0x0F;
        }

        // With the boot ROM mapped, the dump's top 64 bytes are the ROM as
        // the CPU saw it and the real RAM underneath is in the extra block.
        let extra = data.get(SPC_EXTRA_OFFSET..SPC_EXTRA_OFFSET + 0x40);
        if let (true, Some(hidden)) = (apu.rom_enabled, extra) {
            if hidden.iter().any(|&b| b != 0) {
                apu.ram[IPL_BASE..].copy_from_slice(hidden);
            }
        }

        let mut regs = [0u8; 128];
        regs.copy_from_slice(&data[SPC_DSP_OFFSET..SPC_DSP_OFFSET + 128]);
        apu.dsp.load(&regs);
        Ok(apu)
    }

    /// The ID666 text tag's play length, if the header has one. The binary
    /// tag variant is not recognised and yields `None`.
    pub fn id666_length(data: &[u8]) -> Option<Id666Length> {
        if data.len() < 0x100 || data[0x23] != 0x1A {
            return None;
        }
        let field = |range: std::ops::Range<usize>| -> Option<u32> {
            let raw = &data[range];
            let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
            let text = std::str::from_utf8(&raw[..end]).ok()?;
            if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            text.parse().ok()
        };
        let seconds = field(0xA9..0xAC)?;
        let fade_ms = field(0xAC..0xB1).unwrap_or(0);
        Some(Id666Length { seconds, fade_ms })
    }

    /// Log every write to `addr` into `watch_hits`.
    pub fn watch(&mut self, addr: u16) {
        if !self.watch.contains(&addr) {
            self.watch.push(addr);
        }
    }

    /// Run the CPU up to the next sample boundary and return that sample.
    pub fn run_sample(&mut self) -> (i16, i16) {
        while self.clock < self.next_sample_clock {
            if self.trace_left > 0 {
                self.trace_left -= 1;
                self.trace();
            }
            self.timer_lead = 0;
            let cycles = self.step();
            self.clock += u64::from(cycles);
            // Whatever a timer read inside the instruction already consumed
            // is not counted twice.
            let rest = cycles.saturating_sub(self.timer_lead);
            for timer in &mut self.timers {
                timer.advance(rest);
            }
        }
        self.next_sample_clock += CYCLES_PER_SAMPLE;
        let out = self.dsp.run_sample(&mut self.ram, self.sample_index);
        self.sample_index += 1;
        out
    }

    fn trace(&self) {
        let pc = usize::from(self.pc);
        eprintln!(
            "{:>10} {:04X}: {:02X} {:02X} {:02X}  A={:02X} X={:02X} Y={:02X} SP={:02X} PSW={:02X}",
            self.clock,
            self.pc,
            self.ram[pc],
            self.ram[(pc + 1) & 0xFFFF],
            self.ram[(pc + 2) & 0xFFFF],
            self.a,
            self.x,
            self.y,
            self.sp,
            self.psw
        );
    }

    #[inline]
    pub(crate) fn read(&mut self, addr: u16) -> u8 {
        let a = usize::from(addr);
        if a & 0xFFF0 == 0x00F0 {
            return self.read_io(addr);
        }
        if a >= IPL_BASE && self.rom_enabled {
            return IPL_ROM[a - IPL_BASE];
        }
        self.ram[a]
    }

    #[inline]
    pub(crate) fn write(&mut self, addr: u16, value: u8) {
        let a = usize::from(addr);
        // Writes always reach RAM, including under the boot ROM and the I/O
        // page; the registers below are a separate copy.
        self.ram[a] = value;
        if a & 0xFFF0 == 0x00F0 {
            self.write_io(addr, value);
        }
        if !self.watch.is_empty() && self.watch.contains(&addr) {
            self.watch_hits.push(WatchHit {
                sample: self.sample_index,
                addr,
                value,
                pc: self.op_pc,
            });
        }
    }

    fn read_io(&mut self, addr: u16) -> u8 {
        match addr & 0x0F {
            // TEST, CONTROL and the timer targets are write-only.
            0x0 | 0x1 | 0xA | 0xB | 0xC => 0,
            0x2 => self.dsp_addr,
            0x3 => self.dsp.read(self.dsp_addr),
            n @ 0x4..=0x7 => self.port_in[usize::from(n) - 4],
            // AUXIO4/5 are unconnected pins and behave as RAM.
            0x8 | 0x9 => self.ram[usize::from(addr)],
            n => {
                // Bring the timers up to the cycle of the read: the last one
                // of the instruction, for every opcode that can load from
                // the direct page.
                let upto = u32::from(CYCLES[usize::from(self.op)]).saturating_sub(1);
                if upto > self.timer_lead {
                    let ahead = upto - self.timer_lead;
                    for timer in &mut self.timers {
                        timer.advance(ahead);
                    }
                    self.timer_lead = upto;
                }
                // Reading a timer output returns its 4-bit count and clears it.
                let timer = &mut self.timers[usize::from(n) - 0xD];
                let out = timer.out;
                timer.out = 0;
                out
            }
        }
    }

    fn write_io(&mut self, addr: u16, value: u8) {
        match addr & 0x0F {
            0x1 => {
                for (i, timer) in self.timers.iter_mut().enumerate() {
                    let enable = value & (1 << i) != 0;
                    // A 0 -> 1 transition restarts the divider and the output.
                    if enable && !timer.enabled {
                        timer.divider = 0;
                        timer.out = 0;
                    }
                    timer.enabled = enable;
                }
                if value & 0x10 != 0 {
                    self.port_in[0] = 0;
                    self.port_in[1] = 0;
                }
                if value & 0x20 != 0 {
                    self.port_in[2] = 0;
                    self.port_in[3] = 0;
                }
                self.rom_enabled = value & 0x80 != 0;
            }
            0x2 => self.dsp_addr = value,
            // $80-$FF mirror the registers read-only.
            0x3 if self.dsp_addr < 0x80 => self.dsp.write(self.dsp_addr, value),
            n @ 0x4..=0x7 => self.port_out[usize::from(n) - 4] = value,
            n @ 0xA..=0xC => self.timers[usize::from(n) - 0xA].target = value,
            // TEST is left alone (the default $0A is assumed); AUXIO is RAM;
            // the timer outputs are read-only.
            _ => {}
        }
    }
}

impl Default for Apu {
    fn default() -> Self {
        Self::new()
    }
}
