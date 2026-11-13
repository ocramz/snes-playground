//! WDC 65C816 core.
//!
//! Every bus access goes through `Bus::read`/`Bus::write`, which charge the
//! master cycles for that address; internal operations charge 6 via
//! `Bus::idle`. So the cycle count of an instruction is not taken from a
//! table but falls out of the access sequence, which follows the fullsnes
//! "CPU Clock Cycles" chart (C=opcode, P=operand, D=data, N=internal,
//! S=stack, +n when DL!=0, +y for X=0 or a page cross on indexed reads,
//! +x for a taken branch crossing a page in emulation mode).
//!
//! Decimal-mode ADC/SBC follow bsnes' nibble-wise algorithm, including the
//! V flag computed before the final decimal adjust.

use crate::bus::Bus;

pub const FC: u8 = 0x01;
pub const FZ: u8 = 0x02;
pub const FI: u8 = 0x04;
pub const FD: u8 = 0x08;
pub const FX: u8 = 0x10;
pub const FM: u8 = 0x20;
pub const FV: u8 = 0x40;
pub const FN: u8 = 0x80;

const VEC_COP_N: u32 = 0xFFE4;
const VEC_BRK_N: u32 = 0xFFE6;
const VEC_NMI_N: u32 = 0xFFEA;
const VEC_IRQ_N: u32 = 0xFFEE;
const VEC_COP_E: u32 = 0xFFF4;
const VEC_NMI_E: u32 = 0xFFFA;
const VEC_RESET_E: u32 = 0xFFFC;
const VEC_IRQ_E: u32 = 0xFFFE;

/// Addressing modes of the regular ALU/load/store columns.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    DpXInd,     // (dp,X)
    Sr,         // sr,S
    Dp,         // dp
    DpIndLong,  // [dp]
    Abs,        // abs
    Long,       // long
    DpIndY,     // (dp),Y
    DpInd,      // (dp)
    SrIndY,     // (sr,S),Y
    DpX,        // dp,X
    DpY,        // dp,Y
    DpIndLongY, // [dp],Y
    AbsY,       // abs,Y
    AbsX,       // abs,X
    LongX,      // long,X
}

pub struct Cpu {
    pub a: u16,
    pub x: u16,
    pub y: u16,
    pub s: u16,
    pub d: u16,
    pub db: u8,
    pub pb: u8,
    pub pc: u16,
    pub p: u8,
    pub e: bool,
    pub waiting: bool,
    pub stopped: bool,
    pub instructions: u64,
    pub bus: Bus,
}

impl Cpu {
    pub fn new(bus: Bus) -> Self {
        let mut c = Self {
            a: 0,
            x: 0,
            y: 0,
            s: 0x01FF,
            d: 0,
            db: 0,
            pb: 0,
            pc: 0,
            p: FM | FX | FI,
            e: true,
            waiting: false,
            stopped: false,
            instructions: 0,
            bus,
        };
        let lo = c.bus.peek(VEC_RESET_E);
        let hi = c.bus.peek(VEC_RESET_E + 1);
        c.pc = u16::from_le_bytes([lo, hi]);
        c
    }

    #[inline]
    pub fn pc24(&self) -> u32 {
        (u32::from(self.pb) << 16) | u32::from(self.pc)
    }
    #[inline]
    fn m8(&self) -> bool {
        self.p & FM != 0
    }
    #[inline]
    fn x8(&self) -> bool {
        self.p & FX != 0
    }
    #[inline]
    fn flag(&self, f: u8) -> bool {
        self.p & f != 0
    }
    #[inline]
    fn setf(&mut self, f: u8, on: bool) {
        if on {
            self.p |= f;
        } else {
            self.p &= !f;
        }
    }
    #[inline]
    fn nz8(&mut self, v: u8) {
        self.setf(FZ, v == 0);
        self.setf(FN, v & 0x80 != 0);
    }
    #[inline]
    fn nz16(&mut self, v: u16) {
        self.setf(FZ, v == 0);
        self.setf(FN, v & 0x8000 != 0);
    }

    /// Apply the side effects of a new P (or E): 8-bit index registers lose
    /// their high byte, emulation mode forces M=X=1 and a page-1 stack.
    fn fix_p(&mut self) {
        if self.e {
            self.p |= FM | FX;
            self.s = 0x0100 | (self.s & 0xFF);
        }
        if self.p & FX != 0 {
            self.x &= 0xFF;
            self.y &= 0xFF;
        }
    }

    // --- bus helpers -------------------------------------------------------

    #[inline]
    fn rd(&mut self, a: u32) -> u8 {
        self.bus.read(a & 0xFF_FFFF)
    }
    #[inline]
    fn wr(&mut self, a: u32, v: u8) {
        self.bus.write(a & 0xFF_FFFF, v)
    }
    #[inline]
    fn io(&mut self) {
        self.bus.idle()
    }
    #[inline]
    fn fetch(&mut self) -> u8 {
        let v = self.rd(self.pc24());
        self.pc = self.pc.wrapping_add(1);
        v
    }
    #[inline]
    fn fetch16(&mut self) -> u16 {
        let lo = self.fetch();
        let hi = self.fetch();
        u16::from_le_bytes([lo, hi])
    }
    fn fetch24(&mut self) -> u32 {
        let lo = self.fetch16();
        let bank = self.fetch();
        (u32::from(bank) << 16) | u32::from(lo)
    }

    /// Next byte address: within bank 0 for direct page / stack modes,
    /// linear across banks otherwise.
    #[inline]
    fn next(a: u32, bank0: bool) -> u32 {
        if bank0 {
            (a + 1) & 0xFFFF
        } else {
            (a + 1) & 0xFF_FFFF
        }
    }

    fn rd16(&mut self, a: u32, bank0: bool) -> u16 {
        let lo = self.rd(a);
        let hi = self.rd(Self::next(a, bank0));
        u16::from_le_bytes([lo, hi])
    }

    fn push8(&mut self, v: u8) {
        self.wr(u32::from(self.s), v);
        self.s = if self.e {
            0x0100 | (self.s.wrapping_sub(1) & 0xFF)
        } else {
            self.s.wrapping_sub(1)
        };
    }
    fn pull8(&mut self) -> u8 {
        self.s = if self.e {
            0x0100 | (self.s.wrapping_add(1) & 0xFF)
        } else {
            self.s.wrapping_add(1)
        };
        self.rd(u32::from(self.s))
    }
    fn push16(&mut self, v: u16) {
        self.push8((v >> 8) as u8);
        self.push8(v as u8);
    }
    fn pull16(&mut self) -> u16 {
        let lo = self.pull8();
        let hi = self.pull8();
        u16::from_le_bytes([lo, hi])
    }

    /// The +n cycle: direct page not page-aligned.
    #[inline]
    fn dl_io(&mut self) {
        if self.d & 0xFF != 0 {
            self.io();
        }
    }

    #[inline]
    fn dp_addr(&self, off: u8) -> u32 {
        u32::from(self.d.wrapping_add(u16::from(off)))
    }

    /// Direct page indexed; in emulation mode with DL=0 it wraps in the page.
    #[inline]
    fn dp_idx(&self, off: u8, idx: u16) -> u32 {
        if self.e && self.d & 0xFF == 0 {
            u32::from((self.d & 0xFF00) | u16::from(off.wrapping_add(idx as u8)))
        } else {
            u32::from(self.d.wrapping_add(u16::from(off)).wrapping_add(idx))
        }
    }

    /// Indexed with the +y rule: an internal cycle for writes, for 16-bit
    /// index registers, or when the index carries into the next page.
    fn index(&mut self, base: u32, idx: u16, write: bool) -> u32 {
        let a = (base + u32::from(idx)) & 0xFF_FFFF;
        if write || !self.x8() || (a & 0xFFFF00) != (base & 0xFFFF00) {
            self.io();
        }
        a
    }

    /// Effective address for `mode`; returns (address, wraps-in-bank-0).
    fn ea(&mut self, mode: Mode, write: bool) -> (u32, bool) {
        let dbr = u32::from(self.db) << 16;
        match mode {
            Mode::Dp => {
                let o = self.fetch();
                self.dl_io();
                (self.dp_addr(o), true)
            }
            Mode::DpX => {
                let o = self.fetch();
                self.dl_io();
                self.io();
                (self.dp_idx(o, self.x), true)
            }
            Mode::DpY => {
                let o = self.fetch();
                self.dl_io();
                self.io();
                (self.dp_idx(o, self.y), true)
            }
            Mode::DpInd => {
                let o = self.fetch();
                self.dl_io();
                let p = self.dp_addr(o);
                let ptr = self.rd16(p, true);
                (dbr | u32::from(ptr), false)
            }
            Mode::DpXInd => {
                let o = self.fetch();
                self.dl_io();
                self.io();
                let p = self.dp_idx(o, self.x);
                let ptr = self.rd16(p, true);
                (dbr | u32::from(ptr), false)
            }
            Mode::DpIndY => {
                let o = self.fetch();
                self.dl_io();
                let p = self.dp_addr(o);
                let ptr = self.rd16(p, true);
                let y = self.y;
                (self.index(dbr | u32::from(ptr), y, write), false)
            }
            Mode::DpIndLong | Mode::DpIndLongY => {
                let o = self.fetch();
                self.dl_io();
                let p = self.dp_addr(o);
                let lo = self.rd(p);
                let p1 = Self::next(p, true);
                let hi = self.rd(p1);
                let bank = self.rd(Self::next(p1, true));
                let base = (u32::from(bank) << 16) | (u32::from(hi) << 8) | u32::from(lo);
                if mode == Mode::DpIndLongY {
                    ((base + u32::from(self.y)) & 0xFF_FFFF, false)
                } else {
                    (base, false)
                }
            }
            Mode::Sr => {
                let o = self.fetch();
                self.io();
                (u32::from(self.s.wrapping_add(u16::from(o))), true)
            }
            Mode::SrIndY => {
                let o = self.fetch();
                self.io();
                let p = u32::from(self.s.wrapping_add(u16::from(o)));
                let ptr = self.rd16(p, true);
                self.io();
                (
                    ((dbr | u32::from(ptr)) + u32::from(self.y)) & 0xFF_FFFF,
                    false,
                )
            }
            Mode::Abs => {
                let a = self.fetch16();
                (dbr | u32::from(a), false)
            }
            Mode::AbsX => {
                let a = self.fetch16();
                let x = self.x;
                (self.index(dbr | u32::from(a), x, write), false)
            }
            Mode::AbsY => {
                let a = self.fetch16();
                let y = self.y;
                (self.index(dbr | u32::from(a), y, write), false)
            }
            Mode::Long => (self.fetch24(), false),
            Mode::LongX => {
                let a = self.fetch24();
                ((a + u32::from(self.x)) & 0xFF_FFFF, false)
            }
        }
    }

    fn group1_mode(low5: u8) -> Mode {
        match low5 {
            0x01 => Mode::DpXInd,
            0x03 => Mode::Sr,
            0x05 => Mode::Dp,
            0x07 => Mode::DpIndLong,
            0x0D => Mode::Abs,
            0x0F => Mode::Long,
            0x11 => Mode::DpIndY,
            0x12 => Mode::DpInd,
            0x13 => Mode::SrIndY,
            0x15 => Mode::DpX,
            0x17 => Mode::DpIndLongY,
            0x19 => Mode::AbsY,
            0x1D => Mode::AbsX,
            _ => Mode::LongX, // 0x1F
        }
    }

    /// Read an M-width (`wide`=false: 8-bit) or 16-bit operand.
    fn load(&mut self, a: u32, bank0: bool, wide: bool) -> u16 {
        if wide {
            self.rd16(a, bank0)
        } else {
            u16::from(self.rd(a))
        }
    }

    fn store(&mut self, a: u32, bank0: bool, wide: bool, v: u16) {
        self.wr(a, v as u8);
        if wide {
            self.wr(Self::next(a, bank0), (v >> 8) as u8);
        }
    }

    fn imm(&mut self, wide: bool) -> u16 {
        if wide {
            self.fetch16()
        } else {
            u16::from(self.fetch())
        }
    }

    // --- ALU ---------------------------------------------------------------

    fn set_a(&mut self, v: u16) {
        if self.m8() {
            self.a = (self.a & 0xFF00) | (v & 0xFF);
            self.nz8(v as u8);
        } else {
            self.a = v;
            self.nz16(v);
        }
    }

    fn adc(&mut self, data: u16) {
        let c = i32::from(self.flag(FC));
        let dec = self.flag(FD);
        if self.m8() {
            let a = i32::from(self.a & 0xFF);
            let d = i32::from(data & 0xFF);
            let mut r;
            if !dec {
                r = a + d + c;
            } else {
                r = (a & 0x0F) + (d & 0x0F) + c;
                if r > 0x09 {
                    r += 0x06;
                }
                let cc = i32::from(r > 0x0F);
                r = (a & 0xF0) + (d & 0xF0) + (cc << 4) + (r & 0x0F);
            }
            self.setf(FV, (!(a ^ d) & (a ^ r) & 0x80) != 0);
            if dec && r > 0x9F {
                r += 0x60;
            }
            self.setf(FC, r > 0xFF);
            self.a = (self.a & 0xFF00) | (r as u16 & 0xFF);
            self.nz8(r as u8);
        } else {
            let a = i32::from(self.a);
            let d = i32::from(data);
            let mut r;
            if !dec {
                r = a + d + c;
            } else {
                r = (a & 0x000F) + (d & 0x000F) + c;
                if r > 0x0009 {
                    r += 0x0006;
                }
                let mut cc = i32::from(r > 0x000F);
                r = (a & 0x00F0) + (d & 0x00F0) + (cc << 4) + (r & 0x000F);
                if r > 0x009F {
                    r += 0x0060;
                }
                cc = i32::from(r > 0x00FF);
                r = (a & 0x0F00) + (d & 0x0F00) + (cc << 8) + (r & 0x00FF);
                if r > 0x09FF {
                    r += 0x0600;
                }
                cc = i32::from(r > 0x0FFF);
                r = (a & 0xF000) + (d & 0xF000) + (cc << 12) + (r & 0x0FFF);
            }
            self.setf(FV, (!(a ^ d) & (a ^ r) & 0x8000) != 0);
            if dec && r > 0x9FFF {
                r += 0x6000;
            }
            self.setf(FC, r > 0xFFFF);
            self.a = r as u16;
            self.nz16(r as u16);
        }
    }

    fn sbc(&mut self, data: u16) {
        let c = i32::from(self.flag(FC));
        let dec = self.flag(FD);
        if self.m8() {
            let a = i32::from(self.a & 0xFF);
            let d = i32::from(!data & 0xFF);
            let mut r;
            if !dec {
                r = a + d + c;
            } else {
                r = (a & 0x0F) + (d & 0x0F) + c;
                if r <= 0x0F {
                    r -= 0x06;
                }
                let cc = i32::from(r > 0x0F);
                r = (a & 0xF0) + (d & 0xF0) + (cc << 4) + (r & 0x0F);
            }
            self.setf(FV, (!(a ^ d) & (a ^ r) & 0x80) != 0);
            if dec && r <= 0xFF {
                r -= 0x60;
            }
            self.setf(FC, r > 0xFF);
            self.a = (self.a & 0xFF00) | (r as u16 & 0xFF);
            self.nz8(r as u8);
        } else {
            let a = i32::from(self.a);
            let d = i32::from(!data);
            let mut r;
            if !dec {
                r = a + d + c;
            } else {
                r = (a & 0x000F) + (d & 0x000F) + c;
                if r <= 0x000F {
                    r -= 0x0006;
                }
                let mut cc = i32::from(r > 0x000F);
                r = (a & 0x00F0) + (d & 0x00F0) + (cc << 4) + (r & 0x000F);
                if r <= 0x00FF {
                    r -= 0x0060;
                }
                cc = i32::from(r > 0x00FF);
                r = (a & 0x0F00) + (d & 0x0F00) + (cc << 8) + (r & 0x00FF);
                if r <= 0x0FFF {
                    r -= 0x0600;
                }
                cc = i32::from(r > 0x0FFF);
                r = (a & 0xF000) + (d & 0xF000) + (cc << 12) + (r & 0x0FFF);
            }
            self.setf(FV, (!(a ^ d) & (a ^ r) & 0x8000) != 0);
            if dec && r <= 0xFFFF {
                r -= 0x6000;
            }
            self.setf(FC, r > 0xFFFF);
            self.a = r as u16;
            self.nz16(r as u16);
        }
    }

    fn compare(&mut self, reg: u16, data: u16, wide: bool) {
        if wide {
            let r = reg.wrapping_sub(data);
            self.setf(FC, reg >= data);
            self.nz16(r);
        } else {
            let (r8, d8) = (reg as u8, data as u8);
            self.setf(FC, r8 >= d8);
            self.nz8(r8.wrapping_sub(d8));
        }
    }

    /// The eight ALU operations of the regular columns (index = op >> 5).
    fn alu(&mut self, g: u8, v: u16) {
        match g {
            0 => {
                let r = self.a | v;
                self.set_a(r)
            }
            1 => {
                let r = self.a & (v | if self.m8() { 0xFF00 } else { 0 });
                self.set_a(r)
            }
            2 => {
                let r = self.a ^ v;
                self.set_a(r)
            }
            3 => self.adc(v),
            5 => self.set_a(v),
            6 => {
                let w = !self.m8();
                self.compare(self.a, v, w)
            }
            7 => self.sbc(v),
            _ => unreachable!(),
        }
    }

    /// Shift/rotate/inc/dec on a value of the given width.
    fn rmw_op(&mut self, kind: u8, v: u16, wide: bool) -> u16 {
        let (msb, mask) = if wide {
            (0x8000u16, 0xFFFFu16)
        } else {
            (0x80, 0xFF)
        };
        let r = match kind {
            0 => {
                // ASL
                self.setf(FC, v & msb != 0);
                (v << 1) & mask
            }
            1 => {
                // ROL
                let c = u16::from(self.flag(FC));
                self.setf(FC, v & msb != 0);
                ((v << 1) | c) & mask
            }
            2 => {
                // LSR
                self.setf(FC, v & 1 != 0);
                v >> 1
            }
            3 => {
                // ROR
                let c = if self.flag(FC) { msb } else { 0 };
                self.setf(FC, v & 1 != 0);
                (v >> 1) | c
            }
            6 => v.wrapping_sub(1) & mask,
            7 => v.wrapping_add(1) & mask,
            _ => unreachable!(),
        };
        if wide {
            self.nz16(r);
        } else {
            self.nz8(r as u8);
        }
        r
    }

    /// Read-modify-write on memory: read, internal cycle, write high then low.
    fn rmw_mem(&mut self, a: u32, bank0: bool, f: impl FnOnce(&mut Self, u16, bool) -> u16) {
        let wide = !self.m8();
        let v = self.load(a, bank0, wide);
        self.io();
        let r = f(self, v, wide);
        if wide {
            self.wr(Self::next(a, bank0), (r >> 8) as u8);
        }
        self.wr(a, r as u8);
    }

    fn branch(&mut self, cond: bool) {
        let off = self.fetch() as i8;
        if cond {
            self.io();
            let old = self.pc;
            self.pc = self.pc.wrapping_add(off as u16);
            if self.e && (old & 0xFF00) != (self.pc & 0xFF00) {
                self.io();
            }
        }
    }

    // --- interrupts ---------------------------------------------------------

    fn interrupt(&mut self, native_vec: u32, emu_vec: u32, brk: bool) {
        if !self.e {
            self.push8(self.pb);
        }
        self.push16(self.pc);
        let p = if self.e {
            if brk {
                self.p | 0x10
            } else {
                self.p & !0x10
            }
        } else {
            self.p
        };
        self.push8(p);
        self.p |= FI;
        self.p &= !FD;
        self.pb = 0;
        let v = if self.e { emu_vec } else { native_vec };
        self.pc = self.rd16(v, false);
    }

    /// Service a pending NMI or IRQ before the next instruction. Returns true
    /// if one was taken.
    fn poll_interrupts(&mut self) -> bool {
        if self.bus.nmi_pending {
            self.bus.nmi_pending = false;
            self.bus.nmi_count += 1;
            self.waiting = false;
            self.io();
            self.io();
            self.interrupt(VEC_NMI_N, VEC_NMI_E, false);
            return true;
        }
        if self.bus.irq_flag {
            // An IRQ ends WAI even with I set; it is taken only with I clear.
            self.waiting = false;
            if !self.flag(FI) {
                self.io();
                self.io();
                self.interrupt(VEC_IRQ_N, VEC_IRQ_E, false);
                return true;
            }
        }
        false
    }

    /// Handle what happens between instructions: a pending NMI/IRQ is taken,
    /// or WAI/STP lets time pass. Returns true when the next call should be
    /// `exec_next` (an instruction is due at `pc24()`).
    pub fn ready(&mut self) -> bool {
        if self.stopped {
            self.bus.idle_until_event();
            return false;
        }
        if (self.bus.nmi_pending || self.bus.irq_flag) && self.poll_interrupts() {
            return false;
        }
        if self.waiting {
            self.bus.idle_until_event();
            return false;
        }
        true
    }

    /// Execute the instruction at PC.
    pub fn exec_next(&mut self) {
        self.bus.op_pc = self.pc24();
        self.instructions += 1;
        let op = self.fetch();
        self.exec(op);
        if self.e {
            self.s = 0x0100 | (self.s & 0xFF);
        }
    }

    fn exec(&mut self, op: u8) {
        let low5 = op & 0x1F;
        let g = op >> 5;
        // Regular ALU columns: ORA AND EOR ADC STA LDA CMP SBC.
        let regular = matches!(
            low5,
            0x01 | 0x03
                | 0x05
                | 0x07
                | 0x09
                | 0x0D
                | 0x0F
                | 0x11
                | 0x12
                | 0x13
                | 0x15
                | 0x17
                | 0x19
                | 0x1D
                | 0x1F
        );
        if op != 0x89 && regular {
            if low5 == 0x09 {
                let wide = !self.m8();
                let v = self.imm(wide);
                self.alu(g, v);
                return;
            }
            let mode = Self::group1_mode(low5);
            let wide = !self.m8();
            if g == 4 {
                let (a, b0) = self.ea(mode, true);
                let v = self.a;
                self.store(a, b0, wide, v);
            } else {
                let (a, b0) = self.ea(mode, false);
                let v = self.load(a, b0, wide);
                self.alu(g, v);
            }
            return;
        }
        match op {
            // --- shifts / inc / dec on memory --------------------------------
            0x06 | 0x0E | 0x16 | 0x1E | 0x26 | 0x2E | 0x36 | 0x3E | 0x46 | 0x4E | 0x56 | 0x5E
            | 0x66 | 0x6E | 0x76 | 0x7E | 0xC6 | 0xCE | 0xD6 | 0xDE | 0xE6 | 0xEE | 0xF6 | 0xFE => {
                let mode = match low5 {
                    0x06 => Mode::Dp,
                    0x0E => Mode::Abs,
                    0x16 => Mode::DpX,
                    _ => Mode::AbsX,
                };
                let (a, b0) = self.ea(mode, true);
                self.rmw_mem(a, b0, |c, v, w| c.rmw_op(g, v, w));
            }
            0x0A | 0x2A | 0x4A | 0x6A | 0x3A | 0x1A => {
                self.io();
                let kind = match op {
                    0x0A => 0,
                    0x2A => 1,
                    0x4A => 2,
                    0x6A => 3,
                    0x3A => 6,
                    _ => 7,
                };
                let wide = !self.m8();
                let v = if wide { self.a } else { self.a & 0xFF };
                let r = self.rmw_op(kind, v, wide);
                self.a = if wide { r } else { (self.a & 0xFF00) | r };
            }
            // TSB / TRB
            0x04 | 0x0C | 0x14 | 0x1C => {
                let mode = if op & 0x08 != 0 { Mode::Abs } else { Mode::Dp };
                let (a, b0) = self.ea(mode, true);
                let set = op < 0x10;
                self.rmw_mem(a, b0, |c, v, w| {
                    let acc = if w { c.a } else { c.a & 0xFF };
                    c.setf(FZ, v & acc == 0);
                    if set {
                        v | acc
                    } else {
                        v & !acc
                    }
                });
            }
            // BIT
            0x24 | 0x2C | 0x34 | 0x3C => {
                let mode = match op {
                    0x24 => Mode::Dp,
                    0x2C => Mode::Abs,
                    0x34 => Mode::DpX,
                    _ => Mode::AbsX,
                };
                let wide = !self.m8();
                let (a, b0) = self.ea(mode, false);
                let v = self.load(a, b0, wide);
                if wide {
                    self.setf(FZ, v & self.a == 0);
                    self.setf(FN, v & 0x8000 != 0);
                    self.setf(FV, v & 0x4000 != 0);
                } else {
                    self.setf(FZ, (v & self.a & 0xFF) == 0);
                    self.setf(FN, v & 0x80 != 0);
                    self.setf(FV, v & 0x40 != 0);
                }
            }
            0x89 => {
                let wide = !self.m8();
                let v = self.imm(wide);
                let acc = if wide { self.a } else { self.a & 0xFF };
                self.setf(FZ, v & acc == 0);
            }
            // --- index register loads/stores/compares -------------------------
            0xA0 | 0xA2 | 0xC0 | 0xE0 => {
                let wide = !self.x8();
                let v = self.imm(wide);
                self.xop(op, v, wide);
            }
            0xA4 | 0xA6 | 0xAC | 0xAE | 0xB4 | 0xB6 | 0xBC | 0xBE | 0xC4 | 0xCC | 0xE4 | 0xEC => {
                let mode = match op {
                    0xA4 | 0xA6 | 0xC4 | 0xE4 => Mode::Dp,
                    0xAC | 0xAE | 0xCC | 0xEC => Mode::Abs,
                    0xB4 => Mode::DpX,
                    0xB6 => Mode::DpY,
                    0xBC => Mode::AbsX,
                    _ => Mode::AbsY, // 0xBE
                };
                let wide = !self.x8();
                let (a, b0) = self.ea(mode, false);
                let v = self.load(a, b0, wide);
                self.xop(op, v, wide);
            }
            0x84 | 0x86 | 0x8C | 0x8E | 0x94 | 0x96 => {
                let mode = match op {
                    0x84 | 0x86 => Mode::Dp,
                    0x8C | 0x8E => Mode::Abs,
                    0x94 => Mode::DpX,
                    _ => Mode::DpY,
                };
                let wide = !self.x8();
                let (a, b0) = self.ea(mode, true);
                let v = if matches!(op, 0x86 | 0x8E | 0x96) {
                    self.x
                } else {
                    self.y
                };
                self.store(a, b0, wide, v);
            }
            // STZ
            0x64 | 0x74 | 0x9C | 0x9E => {
                let mode = match op {
                    0x64 => Mode::Dp,
                    0x74 => Mode::DpX,
                    0x9C => Mode::Abs,
                    _ => Mode::AbsX,
                };
                let wide = !self.m8();
                let (a, b0) = self.ea(mode, true);
                self.store(a, b0, wide, 0);
            }
            // --- branches ------------------------------------------------------
            0x10 => self.branch(!self.flag(FN)),
            0x30 => self.branch(self.flag(FN)),
            0x50 => self.branch(!self.flag(FV)),
            0x70 => self.branch(self.flag(FV)),
            0x90 => self.branch(!self.flag(FC)),
            0xB0 => self.branch(self.flag(FC)),
            0xD0 => self.branch(!self.flag(FZ)),
            0xF0 => self.branch(self.flag(FZ)),
            0x80 => self.branch(true),
            0x82 => {
                let off = self.fetch16();
                self.io();
                self.pc = self.pc.wrapping_add(off);
            }
            // --- flags -----------------------------------------------------------
            0x18 => {
                self.io();
                self.p &= !FC
            }
            0x38 => {
                self.io();
                self.p |= FC
            }
            0x58 => {
                self.io();
                self.p &= !FI
            }
            0x78 => {
                self.io();
                self.p |= FI
            }
            0xB8 => {
                self.io();
                self.p &= !FV
            }
            0xD8 => {
                self.io();
                self.p &= !FD
            }
            0xF8 => {
                self.io();
                self.p |= FD
            }
            0xC2 => {
                let v = self.fetch();
                self.io();
                self.p &= !v;
                self.fix_p();
            }
            0xE2 => {
                let v = self.fetch();
                self.io();
                self.p |= v;
                self.fix_p();
            }
            0xFB => {
                self.io();
                let c = self.flag(FC);
                self.setf(FC, self.e);
                self.e = c;
                if self.e {
                    self.p |= FM | FX;
                }
                self.fix_p();
            }
            // --- transfers ----------------------------------------------------------
            0xAA | 0xA8 => {
                self.io();
                let v = if self.x8() { self.a & 0xFF } else { self.a };
                if op == 0xAA {
                    self.x = v
                } else {
                    self.y = v
                }
                self.nz_x(v);
            }
            0x8A | 0x98 => {
                self.io();
                let v = if op == 0x8A { self.x } else { self.y };
                self.set_a(v);
            }
            0x9A => {
                self.io();
                self.s = if self.e {
                    0x0100 | (self.x & 0xFF)
                } else {
                    self.x
                };
            }
            0xBA => {
                self.io();
                let v = if self.x8() { self.s & 0xFF } else { self.s };
                self.x = v;
                self.nz_x(v);
            }
            0x9B => {
                self.io();
                self.y = self.x;
                let v = self.y;
                self.nz_x(v);
            }
            0xBB => {
                self.io();
                self.x = self.y;
                let v = self.x;
                self.nz_x(v);
            }
            0x5B => {
                self.io();
                self.d = self.a;
                self.nz16(self.d);
            }
            0x7B => {
                self.io();
                self.a = self.d;
                self.nz16(self.a);
            }
            0x1B => {
                self.io();
                self.s = if self.e {
                    0x0100 | (self.a & 0xFF)
                } else {
                    self.a
                };
            }
            0x3B => {
                self.io();
                self.a = self.s;
                self.nz16(self.a);
            }
            0xEB => {
                self.io();
                self.io();
                self.a = self.a.rotate_left(8);
                self.nz8(self.a as u8);
            }
            // --- index inc/dec -----------------------------------------------------
            0xE8 | 0xC8 | 0xCA | 0x88 => {
                self.io();
                let mask = if self.x8() { 0xFF } else { 0xFFFF };
                let r = match op {
                    0xE8 => self.x.wrapping_add(1),
                    0xC8 => self.y.wrapping_add(1),
                    0xCA => self.x.wrapping_sub(1),
                    _ => self.y.wrapping_sub(1),
                } & mask;
                if op == 0xE8 || op == 0xCA {
                    self.x = r
                } else {
                    self.y = r
                }
                self.nz_x(r);
            }
            0xEA => self.io(),
            0x42 => {
                let _ = self.fetch();
            }
            // --- stack ----------------------------------------------------------------
            0x48 => {
                self.io();
                if self.m8() {
                    self.push8(self.a as u8)
                } else {
                    self.push16(self.a)
                }
            }
            0xDA | 0x5A => {
                self.io();
                let v = if op == 0xDA { self.x } else { self.y };
                if self.x8() {
                    self.push8(v as u8)
                } else {
                    self.push16(v)
                }
            }
            0x08 => {
                self.io();
                let p = if self.e { self.p | 0x30 } else { self.p };
                self.push8(p)
            }
            0x8B => {
                self.io();
                self.push8(self.db)
            }
            0x4B => {
                self.io();
                self.push8(self.pb)
            }
            0x0B => {
                self.io();
                self.push16(self.d)
            }
            0x68 => {
                self.io();
                self.io();
                let v = if self.m8() {
                    u16::from(self.pull8())
                } else {
                    self.pull16()
                };
                self.set_a(v);
            }
            0xFA | 0x7A => {
                self.io();
                self.io();
                let v = if self.x8() {
                    u16::from(self.pull8())
                } else {
                    self.pull16()
                };
                if op == 0xFA {
                    self.x = v
                } else {
                    self.y = v
                }
                self.nz_x(v);
            }
            0x28 => {
                self.io();
                self.io();
                self.p = self.pull8();
                self.fix_p();
            }
            0xAB => {
                self.io();
                self.io();
                self.db = self.pull8();
                self.nz8(self.db);
            }
            0x2B => {
                self.io();
                self.io();
                self.d = self.pull16();
                self.nz16(self.d);
            }
            0xF4 => {
                let v = self.fetch16();
                self.push16(v);
            }
            0xD4 => {
                let o = self.fetch();
                self.dl_io();
                let p = self.dp_addr(o);
                let v = self.rd16(p, true);
                self.push16(v);
            }
            0x62 => {
                let off = self.fetch16();
                self.io();
                let v = self.pc.wrapping_add(off);
                self.push16(v);
            }
            // --- jumps and calls ---------------------------------------------------------
            0x4C => self.pc = self.fetch16(),
            0x5C => {
                let a = self.fetch24();
                self.pc = a as u16;
                self.pb = (a >> 16) as u8;
            }
            0x6C => {
                let a = self.fetch16();
                self.pc = self.rd16(u32::from(a), true);
            }
            0x7C => {
                let a = self.fetch16();
                self.io();
                let p = (u32::from(self.pb) << 16) | u32::from(a.wrapping_add(self.x));
                let lo = self.rd(p);
                let hi = self.rd((p & 0xFF_0000) | ((p + 1) & 0xFFFF));
                self.pc = u16::from_le_bytes([lo, hi]);
            }
            0xDC => {
                let a = u32::from(self.fetch16());
                let lo = self.rd(a);
                let hi = self.rd((a + 1) & 0xFFFF);
                let bank = self.rd((a + 2) & 0xFFFF);
                self.pc = u16::from_le_bytes([lo, hi]);
                self.pb = bank;
            }
            0x20 => {
                let a = self.fetch16();
                self.io();
                let ret = self.pc.wrapping_sub(1);
                self.push16(ret);
                self.pc = a;
            }
            0x22 => {
                let a = self.fetch16();
                self.push8(self.pb);
                self.io();
                let bank = self.fetch();
                let ret = self.pc.wrapping_sub(1);
                self.push16(ret);
                self.pc = a;
                self.pb = bank;
            }
            0xFC => {
                let lo = self.fetch();
                let ret = self.pc; // address of the operand's last byte
                self.push16(ret);
                let hi = self.fetch();
                self.io();
                let a = u16::from_le_bytes([lo, hi]).wrapping_add(self.x);
                let p = (u32::from(self.pb) << 16) | u32::from(a);
                let tl = self.rd(p);
                let th = self.rd((p & 0xFF_0000) | ((p + 1) & 0xFFFF));
                self.pc = u16::from_le_bytes([tl, th]);
            }
            0x60 => {
                self.io();
                self.io();
                self.pc = self.pull16();
                self.io();
                self.pc = self.pc.wrapping_add(1);
            }
            0x6B => {
                self.io();
                self.io();
                self.pc = self.pull16().wrapping_add(1);
                self.pb = self.pull8();
            }
            0x40 => {
                self.io();
                self.io();
                self.p = self.pull8();
                self.fix_p();
                self.pc = self.pull16();
                if !self.e {
                    self.pb = self.pull8();
                }
            }
            0x00 => {
                let _ = self.fetch();
                self.interrupt(VEC_BRK_N, VEC_IRQ_E, true);
            }
            0x02 => {
                let _ = self.fetch();
                self.interrupt(VEC_COP_N, VEC_COP_E, false);
            }
            // --- block move ---------------------------------------------------------------
            0x54 | 0x44 => {
                let dst = self.fetch();
                let src = self.fetch();
                self.db = dst;
                let v = self.rd((u32::from(src) << 16) | u32::from(self.x));
                self.wr((u32::from(dst) << 16) | u32::from(self.y), v);
                self.io();
                self.io();
                let mask = if self.x8() { 0xFF } else { 0xFFFF };
                if op == 0x54 {
                    self.x = self.x.wrapping_add(1) & mask;
                    self.y = self.y.wrapping_add(1) & mask;
                } else {
                    self.x = self.x.wrapping_sub(1) & mask;
                    self.y = self.y.wrapping_sub(1) & mask;
                }
                self.a = self.a.wrapping_sub(1);
                if self.a != 0xFFFF {
                    self.pc = self.pc.wrapping_sub(3);
                }
            }
            0xCB => {
                self.io();
                self.io();
                self.waiting = true;
            }
            0xDB => {
                self.io();
                self.io();
                self.stopped = true;
            }
            _ => unreachable!("opcode {op:02X} not decoded"),
        }
    }

    fn nz_x(&mut self, v: u16) {
        if self.x8() {
            self.nz8(v as u8)
        } else {
            self.nz16(v)
        }
    }

    /// LDX/LDY/CPX/CPY with the operand already read.
    fn xop(&mut self, op: u8, v: u16, wide: bool) {
        match op {
            0xA0 | 0xA4 | 0xAC | 0xB4 | 0xBC => {
                self.y = v;
                self.nz_x(v);
            }
            0xA2 | 0xA6 | 0xAE | 0xB6 | 0xBE => {
                self.x = v;
                self.nz_x(v);
            }
            0xC0 | 0xC4 | 0xCC => self.compare(self.y, v, wide),
            _ => self.compare(self.x, v, wide), // E0 E4 EC
        }
    }

    pub fn save_state(&self, w: &mut crate::state::Writer) {
        for v in [self.a, self.x, self.y, self.s, self.d, self.pc] {
            w.u16(v);
        }
        w.u8(self.db);
        w.u8(self.pb);
        w.u8(self.p);
        w.bool(self.e);
        w.bool(self.waiting);
        w.bool(self.stopped);
        w.u64(self.instructions);
        self.bus.save(w);
    }

    pub fn load_state(&mut self, r: &mut crate::state::Reader) {
        self.a = r.u16();
        self.x = r.u16();
        self.y = r.u16();
        self.s = r.u16();
        self.d = r.u16();
        self.pc = r.u16();
        self.db = r.u8();
        self.pb = r.u8();
        self.p = r.u8();
        self.e = r.bool();
        self.waiting = r.bool();
        self.stopped = r.bool();
        self.instructions = r.u64();
        self.bus.load(r);
    }
}
