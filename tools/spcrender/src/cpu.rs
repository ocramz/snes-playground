//! The SPC700 instruction set.
//!
//! Semantics, flags and operand byte order follow the fullsnes "SNES APU
//! SPC700 CPU" sections; cycle counts come from `tables::CYCLES`. The match
//! in `step` names every one of the 256 opcodes with no wildcard arm, so the
//! compiler proves the decode is total and free of overlaps.
//!
//! Operand order on the wire, where it is not the obvious one: two-operand
//! forms store the source first (`MOV dd,ds` is `FA ss dd`, `MOV d,#i` is
//! `8F ii dd`), and a relative offset always comes last (`CBNE d,r` is
//! `2E dd rr`).

use crate::apu::Apu;
use crate::tables::CYCLES;

pub const FLAG_C: u8 = 0x01;
pub const FLAG_Z: u8 = 0x02;
pub const FLAG_I: u8 = 0x04;
pub const FLAG_H: u8 = 0x08;
pub const FLAG_B: u8 = 0x10;
pub const FLAG_P: u8 = 0x20;
pub const FLAG_V: u8 = 0x40;
pub const FLAG_N: u8 = 0x80;

/// Extra cycles a conditional branch costs when it is taken.
const BRANCH_TAKEN: u32 = 2;

/// The result of `DIV YA,X`: quotient, remainder and the two flags the
/// divider leaves behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DivResult {
    pub a: u8,
    pub y: u8,
    pub v: bool,
    pub h: bool,
}

/// `DIV YA,X` as the hardware's 9-step restoring divider, transcribed from
/// fullsnes "SPC700 Division Overflow/Result". Unlike a plain `/` and `%`
/// this also reproduces the results when the quotient does not fit in 9
/// bits, and it has no special case for `X == 0`.
pub fn div_ya_x(ya: u16, x: u8) -> DivResult {
    let y = (ya >> 8) as u8;
    let divisor = u32::from(x) << 9;
    let mut temp = u32::from(ya);
    for _ in 0..9 {
        temp <<= 1;
        if temp & 0x2_0000 != 0 {
            temp ^= 0x2_0001;
        }
        if temp >= divisor {
            temp ^= 1;
        }
        if temp & 1 != 0 {
            temp = temp.wrapping_sub(divisor) & 0x1_FFFF;
        }
    }
    DivResult {
        a: (temp & 0xFF) as u8,
        y: (temp >> 9) as u8,
        v: temp & 0x100 != 0,
        h: (x & 0x0F) <= (y & 0x0F),
    }
}

impl Apu {
    #[inline]
    fn fetch(&mut self) -> u8 {
        let value = self.read(self.pc);
        self.pc = self.pc.wrapping_add(1);
        value
    }

    #[inline]
    fn fetch16(&mut self) -> u16 {
        let lo = self.fetch();
        let hi = self.fetch();
        u16::from_le_bytes([lo, hi])
    }

    /// Direct-page address: page 0 or page 1 depending on the P flag.
    #[inline]
    fn dp(&self, offset: u8) -> u16 {
        (u16::from(self.psw & FLAG_P) << 3) | u16::from(offset)
    }

    #[inline]
    fn read16(&mut self, addr: u16) -> u16 {
        let lo = self.read(addr);
        let hi = self.read(addr.wrapping_add(1));
        u16::from_le_bytes([lo, hi])
    }

    /// A 16-bit value in the direct page; the high byte wraps within the page.
    #[inline]
    fn read16_dp(&mut self, offset: u8) -> u16 {
        let lo = self.read(self.dp(offset));
        let hi = self.read(self.dp(offset.wrapping_add(1)));
        u16::from_le_bytes([lo, hi])
    }

    #[inline]
    fn set_flag(&mut self, flag: u8, on: bool) {
        if on {
            self.psw |= flag;
        } else {
            self.psw &= !flag;
        }
    }

    #[inline]
    fn set_nz(&mut self, value: u8) {
        self.psw = (self.psw & !(FLAG_N | FLAG_Z))
            | (value & FLAG_N)
            | if value == 0 { FLAG_Z } else { 0 };
    }

    #[inline]
    fn set_nz16(&mut self, value: u16) {
        self.set_flag(FLAG_N, value & 0x8000 != 0);
        self.set_flag(FLAG_Z, value == 0);
    }

    #[inline]
    fn carry(&self) -> u8 {
        self.psw & FLAG_C
    }

    #[inline]
    fn ya(&self) -> u16 {
        u16::from_le_bytes([self.a, self.y])
    }

    #[inline]
    fn set_ya(&mut self, value: u16) {
        let [lo, hi] = value.to_le_bytes();
        self.a = lo;
        self.y = hi;
    }

    #[inline]
    fn push(&mut self, value: u8) {
        self.write(0x0100 | u16::from(self.sp), value);
        self.sp = self.sp.wrapping_sub(1);
    }

    #[inline]
    fn pop(&mut self) -> u8 {
        self.sp = self.sp.wrapping_add(1);
        self.read(0x0100 | u16::from(self.sp))
    }

    fn push_pc(&mut self) {
        let [lo, hi] = self.pc.to_le_bytes();
        self.push(hi);
        self.push(lo);
    }

    fn pop_pc(&mut self) {
        let lo = self.pop();
        let hi = self.pop();
        self.pc = u16::from_le_bytes([lo, hi]);
    }

    /// Fetch the offset and take the branch if `taken`; returns extra cycles.
    #[inline]
    fn branch(&mut self, taken: bool) -> u32 {
        let offset = self.fetch() as i8;
        if taken {
            self.pc = self.pc.wrapping_add(offset as u16);
            BRANCH_TAKEN
        } else {
            0
        }
    }

    fn adc(&mut self, a: u8, b: u8) -> u8 {
        let carry = u16::from(self.carry());
        let sum = u16::from(a) + u16::from(b) + carry;
        let result = sum as u8;
        self.set_flag(FLAG_C, sum > 0xFF);
        self.set_flag(
            FLAG_H,
            u16::from(a & 0x0F) + u16::from(b & 0x0F) + carry > 0x0F,
        );
        self.set_flag(FLAG_V, !(a ^ b) & (a ^ result) & 0x80 != 0);
        self.set_nz(result);
        result
    }

    /// `a - b - !C`, which is `a + !b + C` with the same flag rules.
    fn sbc(&mut self, a: u8, b: u8) -> u8 {
        self.adc(a, !b)
    }

    fn cmp(&mut self, a: u8, b: u8) {
        self.set_flag(FLAG_C, a >= b);
        self.set_nz(a.wrapping_sub(b));
    }

    /// The six operations of the 8-bit ALU group, selected by opcode bits
    /// 7-5: OR, AND, EOR, CMP, ADC, SBC. CMP returns its left operand
    /// unchanged so callers can store the result unconditionally into a
    /// register; memory forms check `ALU_CMP` and skip the write.
    fn alu(&mut self, which: u8, a: u8, b: u8) -> u8 {
        match which {
            0 => {
                let r = a | b;
                self.set_nz(r);
                r
            }
            1 => {
                let r = a & b;
                self.set_nz(r);
                r
            }
            2 => {
                let r = a ^ b;
                self.set_nz(r);
                r
            }
            3 => {
                self.cmp(a, b);
                a
            }
            4 => self.adc(a, b),
            _ => self.sbc(a, b),
        }
    }

    /// The shift/step group, selected by opcode bits 7-5: ASL, ROL, LSR,
    /// ROR, DEC, INC.
    fn rmw(&mut self, which: u8, value: u8) -> u8 {
        let carry_in = self.carry();
        let result = match which {
            0 => {
                self.set_flag(FLAG_C, value & 0x80 != 0);
                value << 1
            }
            1 => {
                self.set_flag(FLAG_C, value & 0x80 != 0);
                (value << 1) | carry_in
            }
            2 => {
                self.set_flag(FLAG_C, value & 0x01 != 0);
                value >> 1
            }
            3 => {
                self.set_flag(FLAG_C, value & 0x01 != 0);
                (value >> 1) | (carry_in << 7)
            }
            4 => value.wrapping_sub(1),
            _ => value.wrapping_add(1),
        };
        self.set_nz(result);
        result
    }

    /// Effective address for the eight memory addressing modes shared by the
    /// ALU, load and store groups, keyed by opcode bits 4-0.
    fn ea(&mut self, mode: u8) -> u16 {
        match mode {
            // d
            0x04 => {
                let d = self.fetch();
                self.dp(d)
            }
            // !a
            0x05 => self.fetch16(),
            // (X)
            0x06 => self.dp(self.x),
            // [d+X]
            0x07 => {
                let d = self.fetch().wrapping_add(self.x);
                self.read16_dp(d)
            }
            // d+X
            0x14 => {
                let d = self.fetch().wrapping_add(self.x);
                self.dp(d)
            }
            // !a+X
            0x15 => self.fetch16().wrapping_add(u16::from(self.x)),
            // !a+Y
            0x16 => self.fetch16().wrapping_add(u16::from(self.y)),
            // [d]+Y
            _ => {
                let d = self.fetch();
                self.read16_dp(d).wrapping_add(u16::from(self.y))
            }
        }
    }

    /// Address and bit number of an `m.b` operand: 13 bits of address, 3 of bit.
    fn bit_operand(&mut self) -> (u16, u8) {
        let word = self.fetch16();
        (word & 0x1FFF, (word >> 13) as u8)
    }

    fn read_bit(&mut self) -> bool {
        let (addr, bit) = self.bit_operand();
        self.read(addr) & (1 << bit) != 0
    }

    /// Store with the dummy read most store opcodes perform first (fullsnes,
    /// "Memory Store": they are implemented as read-modify-write, which
    /// matters for the read-sensitive timer outputs).
    #[inline]
    fn store(&mut self, addr: u16, value: u8) {
        let _ = self.read(addr);
        self.write(addr, value);
    }

    /// Execute one instruction and return the cycles it took.
    pub fn step(&mut self) -> u32 {
        if self.halted {
            // Let time pass so the timers and the DSP keep running.
            return 2;
        }
        self.op_pc = self.pc;
        let op = self.fetch();
        self.op = op;
        self.instructions += 1;
        self.opcodes_seen[usize::from(op >> 6)] |= 1 << (op & 0x3F);
        let which = op >> 5;
        let mode = op & 0x1F;
        let mut cycles = u32::from(CYCLES[usize::from(op)]);

        match op {
            // NOP
            0x00 => {}

            // TCALL n
            0x01 | 0x11 | 0x21 | 0x31 | 0x41 | 0x51 | 0x61 | 0x71 | 0x81 | 0x91 | 0xA1 | 0xB1
            | 0xC1 | 0xD1 | 0xE1 | 0xF1 => {
                self.push_pc();
                self.pc = self.read16(0xFFDE - 2 * u16::from(op >> 4));
            }

            // SET1 d.b
            0x02 | 0x22 | 0x42 | 0x62 | 0x82 | 0xA2 | 0xC2 | 0xE2 => {
                let d = self.fetch();
                let addr = self.dp(d);
                let value = self.read(addr) | (1 << which);
                self.write(addr, value);
            }
            // CLR1 d.b
            0x12 | 0x32 | 0x52 | 0x72 | 0x92 | 0xB2 | 0xD2 | 0xF2 => {
                let d = self.fetch();
                let addr = self.dp(d);
                let value = self.read(addr) & !(1 << which);
                self.write(addr, value);
            }

            // BBS d.b,r
            0x03 | 0x23 | 0x43 | 0x63 | 0x83 | 0xA3 | 0xC3 | 0xE3 => {
                let d = self.fetch();
                let value = self.read(self.dp(d));
                cycles += self.branch(value & (1 << which) != 0);
            }
            // BBC d.b,r
            0x13 | 0x33 | 0x53 | 0x73 | 0x93 | 0xB3 | 0xD3 | 0xF3 => {
                let d = self.fetch();
                let value = self.read(self.dp(d));
                cycles += self.branch(value & (1 << which) == 0);
            }

            // OR/AND/EOR/CMP/ADC/SBC A,<memory>
            0x04 | 0x05 | 0x06 | 0x07 | 0x14 | 0x15 | 0x16 | 0x17 | 0x24 | 0x25 | 0x26 | 0x27
            | 0x34 | 0x35 | 0x36 | 0x37 | 0x44 | 0x45 | 0x46 | 0x47 | 0x54 | 0x55 | 0x56 | 0x57
            | 0x64 | 0x65 | 0x66 | 0x67 | 0x74 | 0x75 | 0x76 | 0x77 | 0x84 | 0x85 | 0x86 | 0x87
            | 0x94 | 0x95 | 0x96 | 0x97 | 0xA4 | 0xA5 | 0xA6 | 0xA7 | 0xB4 | 0xB5 | 0xB6 | 0xB7 => {
                let addr = self.ea(mode);
                let operand = self.read(addr);
                self.a = self.alu(which, self.a, operand);
            }
            // OR/AND/EOR/CMP/ADC/SBC A,#i
            0x08 | 0x28 | 0x48 | 0x68 | 0x88 | 0xA8 => {
                let operand = self.fetch();
                self.a = self.alu(which, self.a, operand);
            }
            // OR/AND/EOR/CMP/ADC/SBC dd,ds
            0x09 | 0x29 | 0x49 | 0x69 | 0x89 | 0xA9 => {
                let src = self.fetch();
                let operand = self.read(self.dp(src));
                let dst = self.fetch();
                let addr = self.dp(dst);
                let left = self.read(addr);
                let result = self.alu(which, left, operand);
                if which != 3 {
                    self.write(addr, result);
                }
            }
            // OR/AND/EOR/CMP/ADC/SBC d,#i
            0x18 | 0x38 | 0x58 | 0x78 | 0x98 | 0xB8 => {
                let operand = self.fetch();
                let dst = self.fetch();
                let addr = self.dp(dst);
                let left = self.read(addr);
                let result = self.alu(which, left, operand);
                if which != 3 {
                    self.write(addr, result);
                }
            }
            // OR/AND/EOR/CMP/ADC/SBC (X),(Y)
            0x19 | 0x39 | 0x59 | 0x79 | 0x99 | 0xB9 => {
                let operand = self.read(self.dp(self.y));
                let addr = self.dp(self.x);
                let left = self.read(addr);
                let result = self.alu(which, left, operand);
                if which != 3 {
                    self.write(addr, result);
                }
            }

            // ASL/ROL/LSR/ROR/DEC/INC d, d+X
            0x0B | 0x1B | 0x2B | 0x3B | 0x4B | 0x5B | 0x6B | 0x7B | 0x8B | 0x9B | 0xAB | 0xBB => {
                let mut d = self.fetch();
                if mode == 0x1B {
                    d = d.wrapping_add(self.x);
                }
                let addr = self.dp(d);
                let value = self.read(addr);
                let result = self.rmw(which, value);
                self.write(addr, result);
            }
            // ASL/ROL/LSR/ROR/DEC/INC !a
            0x0C | 0x2C | 0x4C | 0x6C | 0x8C | 0xAC => {
                let addr = self.fetch16();
                let value = self.read(addr);
                let result = self.rmw(which, value);
                self.write(addr, result);
            }
            // ASL/ROL/LSR/ROR/DEC/INC A
            0x1C | 0x3C | 0x5C | 0x7C | 0x9C | 0xBC => self.a = self.rmw(which, self.a),
            // DEC X / INC X / DEC Y / INC Y
            0x1D => self.x = self.rmw(4, self.x),
            0x3D => self.x = self.rmw(5, self.x),
            0xDC => self.y = self.rmw(4, self.y),
            0xFC => self.y = self.rmw(5, self.y),

            // Conditional branches on a flag
            0x10 => cycles += self.branch(self.psw & FLAG_N == 0),
            0x30 => cycles += self.branch(self.psw & FLAG_N != 0),
            0x50 => cycles += self.branch(self.psw & FLAG_V == 0),
            0x70 => cycles += self.branch(self.psw & FLAG_V != 0),
            0x90 => cycles += self.branch(self.psw & FLAG_C == 0),
            0xB0 => cycles += self.branch(self.psw & FLAG_C != 0),
            0xD0 => cycles += self.branch(self.psw & FLAG_Z == 0),
            0xF0 => cycles += self.branch(self.psw & FLAG_Z != 0),

            // Flag set/clear
            0x20 => self.psw &= !FLAG_P,
            0x40 => self.psw |= FLAG_P,
            0x60 => self.psw &= !FLAG_C,
            0x80 => self.psw |= FLAG_C,
            0xA0 => self.psw |= FLAG_I,
            0xC0 => self.psw &= !FLAG_I,
            0xE0 => self.psw &= !(FLAG_V | FLAG_H),
            0xED => self.psw ^= FLAG_C,

            // OR1/AND1/EOR1/MOV1 on the carry, NOT1
            0x0A => {
                let bit = self.read_bit();
                self.set_flag(FLAG_C, self.carry() != 0 || bit);
            }
            0x2A => {
                let bit = self.read_bit();
                self.set_flag(FLAG_C, self.carry() != 0 || !bit);
            }
            0x4A => {
                let bit = self.read_bit();
                self.set_flag(FLAG_C, self.carry() != 0 && bit);
            }
            0x6A => {
                let bit = self.read_bit();
                self.set_flag(FLAG_C, self.carry() != 0 && !bit);
            }
            0x8A => {
                let bit = self.read_bit();
                self.set_flag(FLAG_C, (self.carry() != 0) != bit);
            }
            0xAA => {
                let bit = self.read_bit();
                self.set_flag(FLAG_C, bit);
            }
            0xCA => {
                let (addr, bit) = self.bit_operand();
                let value = self.read(addr);
                let result = if self.carry() != 0 {
                    value | (1 << bit)
                } else {
                    value & !(1 << bit)
                };
                self.write(addr, result);
            }
            0xEA => {
                let (addr, bit) = self.bit_operand();
                let value = self.read(addr) ^ (1 << bit);
                self.write(addr, value);
            }

            // DECW d / INCW d
            0x1A | 0x3A => {
                let d = self.fetch();
                let word = self.read16_dp(d);
                let result = if op == 0x1A {
                    word.wrapping_sub(1)
                } else {
                    word.wrapping_add(1)
                };
                let [lo, hi] = result.to_le_bytes();
                self.write(self.dp(d), lo);
                self.write(self.dp(d.wrapping_add(1)), hi);
                self.set_nz16(result);
            }
            // CMPW YA,d
            0x5A => {
                let d = self.fetch();
                let word = self.read16_dp(d);
                let ya = self.ya();
                self.set_flag(FLAG_C, ya >= word);
                self.set_nz16(ya.wrapping_sub(word));
            }
            // ADDW YA,d
            0x7A => {
                let d = self.fetch();
                let word = self.read16_dp(d);
                let ya = self.ya();
                let sum = u32::from(ya) + u32::from(word);
                let result = sum as u16;
                self.set_flag(FLAG_C, sum > 0xFFFF);
                self.set_flag(FLAG_H, (ya & 0x0FFF) + (word & 0x0FFF) > 0x0FFF);
                self.set_flag(FLAG_V, !(ya ^ word) & (ya ^ result) & 0x8000 != 0);
                self.set_nz16(result);
                self.set_ya(result);
            }
            // SUBW YA,d
            0x9A => {
                let d = self.fetch();
                let word = self.read16_dp(d);
                let ya = self.ya();
                let result = ya.wrapping_sub(word);
                self.set_flag(FLAG_C, ya >= word);
                self.set_flag(FLAG_H, (ya & 0x0FFF) >= (word & 0x0FFF));
                self.set_flag(FLAG_V, (ya ^ word) & (ya ^ result) & 0x8000 != 0);
                self.set_nz16(result);
                self.set_ya(result);
            }
            // MOVW YA,d
            0xBA => {
                let d = self.fetch();
                let word = self.read16_dp(d);
                self.set_ya(word);
                self.set_nz16(word);
            }
            // MOVW d,YA (dummy read of the low byte only)
            0xDA => {
                let d = self.fetch();
                let lo_addr = self.dp(d);
                let _ = self.read(lo_addr);
                self.write(lo_addr, self.a);
                self.write(self.dp(d.wrapping_add(1)), self.y);
            }

            // MOV <memory>,A
            0xC4 | 0xC5 | 0xC6 | 0xC7 | 0xD4 | 0xD5 | 0xD6 | 0xD7 => {
                let addr = self.ea(mode);
                self.store(addr, self.a);
            }
            // MOV !a,X / MOV !a,Y
            0xC9 => {
                let addr = self.fetch16();
                self.store(addr, self.x);
            }
            0xCC => {
                let addr = self.fetch16();
                self.store(addr, self.y);
            }
            // MOV d,X / MOV d+Y,X
            0xD8 => {
                let d = self.fetch();
                self.store(self.dp(d), self.x);
            }
            0xD9 => {
                let d = self.fetch().wrapping_add(self.y);
                self.store(self.dp(d), self.x);
            }
            // MOV d,Y / MOV d+X,Y
            0xCB => {
                let d = self.fetch();
                self.store(self.dp(d), self.y);
            }
            0xDB => {
                let d = self.fetch().wrapping_add(self.x);
                self.store(self.dp(d), self.y);
            }
            // MOV d,#i
            0x8F => {
                let value = self.fetch();
                let d = self.fetch();
                self.store(self.dp(d), value);
            }
            // MOV dd,ds (no dummy read)
            0xFA => {
                let src = self.fetch();
                let value = self.read(self.dp(src));
                let dst = self.fetch();
                self.write(self.dp(dst), value);
            }
            // MOV (X)+,A (no dummy read)
            0xAF => {
                self.write(self.dp(self.x), self.a);
                self.x = self.x.wrapping_add(1);
            }

            // MOV A,<memory>
            0xE4 | 0xE5 | 0xE6 | 0xE7 | 0xF4 | 0xF5 | 0xF6 | 0xF7 => {
                let addr = self.ea(mode);
                self.a = self.read(addr);
                self.set_nz(self.a);
            }
            // MOV A,#i
            0xE8 => {
                self.a = self.fetch();
                self.set_nz(self.a);
            }
            // MOV A,(X)+
            0xBF => {
                self.a = self.read(self.dp(self.x));
                self.x = self.x.wrapping_add(1);
                self.set_nz(self.a);
            }
            // MOV X,#i / d / d+Y / !a
            0xCD => {
                self.x = self.fetch();
                self.set_nz(self.x);
            }
            0xF8 => {
                let d = self.fetch();
                self.x = self.read(self.dp(d));
                self.set_nz(self.x);
            }
            0xF9 => {
                let d = self.fetch().wrapping_add(self.y);
                self.x = self.read(self.dp(d));
                self.set_nz(self.x);
            }
            0xE9 => {
                let addr = self.fetch16();
                self.x = self.read(addr);
                self.set_nz(self.x);
            }
            // MOV Y,#i / d / d+X / !a
            0x8D => {
                self.y = self.fetch();
                self.set_nz(self.y);
            }
            0xEB => {
                let d = self.fetch();
                self.y = self.read(self.dp(d));
                self.set_nz(self.y);
            }
            0xFB => {
                let d = self.fetch().wrapping_add(self.x);
                self.y = self.read(self.dp(d));
                self.set_nz(self.y);
            }
            0xEC => {
                let addr = self.fetch16();
                self.y = self.read(addr);
                self.set_nz(self.y);
            }

            // Register to register
            0x7D => {
                self.a = self.x;
                self.set_nz(self.a);
            }
            0x5D => {
                self.x = self.a;
                self.set_nz(self.x);
            }
            0xDD => {
                self.a = self.y;
                self.set_nz(self.a);
            }
            0xFD => {
                self.y = self.a;
                self.set_nz(self.y);
            }
            0x9D => {
                self.x = self.sp;
                self.set_nz(self.x);
            }
            0xBD => self.sp = self.x,

            // CMP X / CMP Y
            0xC8 => {
                let operand = self.fetch();
                self.cmp(self.x, operand);
            }
            0x3E => {
                let d = self.fetch();
                let operand = self.read(self.dp(d));
                self.cmp(self.x, operand);
            }
            0x1E => {
                let addr = self.fetch16();
                let operand = self.read(addr);
                self.cmp(self.x, operand);
            }
            0xAD => {
                let operand = self.fetch();
                self.cmp(self.y, operand);
            }
            0x7E => {
                let d = self.fetch();
                let operand = self.read(self.dp(d));
                self.cmp(self.y, operand);
            }
            0x5E => {
                let addr = self.fetch16();
                let operand = self.read(addr);
                self.cmp(self.y, operand);
            }

            // Stack
            0x0D => self.push(self.psw),
            0x2D => self.push(self.a),
            0x4D => self.push(self.x),
            0x6D => self.push(self.y),
            0x8E => self.psw = self.pop(),
            0xAE => self.a = self.pop(),
            0xCE => self.x = self.pop(),
            0xEE => self.y = self.pop(),

            // TSET1 !a / TCLR1 !a: N and Z as for CMP A,[a], taken before
            // the memory is changed.
            0x0E | 0x4E => {
                let addr = self.fetch16();
                let value = self.read(addr);
                self.set_nz(self.a.wrapping_sub(value));
                let result = if op == 0x0E {
                    value | self.a
                } else {
                    value & !self.a
                };
                self.write(addr, result);
            }

            // CBNE d,r / CBNE d+X,r
            0x2E | 0xDE => {
                let mut d = self.fetch();
                if op == 0xDE {
                    d = d.wrapping_add(self.x);
                }
                let value = self.read(self.dp(d));
                cycles += self.branch(self.a != value);
            }
            // DBNZ d,r
            0x6E => {
                let d = self.fetch();
                let addr = self.dp(d);
                let value = self.read(addr).wrapping_sub(1);
                self.write(addr, value);
                cycles += self.branch(value != 0);
            }
            // DBNZ Y,r
            0xFE => {
                self.y = self.y.wrapping_sub(1);
                cycles += self.branch(self.y != 0);
            }

            // BRK
            0x0F => {
                self.push_pc();
                self.push(self.psw);
                self.pc = self.read16(0xFFDE);
                self.psw = (self.psw | FLAG_B) & !FLAG_I;
            }
            // JMP [!a+X]
            0x1F => {
                let addr = self.fetch16().wrapping_add(u16::from(self.x));
                self.pc = self.read16(addr);
            }
            // BRA r
            0x2F => {
                let offset = self.fetch() as i8;
                self.pc = self.pc.wrapping_add(offset as u16);
            }
            // CALL !a
            0x3F => {
                let addr = self.fetch16();
                self.push_pc();
                self.pc = addr;
            }
            // PCALL u
            0x4F => {
                let low = self.fetch();
                self.push_pc();
                self.pc = 0xFF00 | u16::from(low);
            }
            // JMP !a
            0x5F => self.pc = self.fetch16(),
            // RET
            0x6F => self.pop_pc(),
            // RETI
            0x7F => {
                self.psw = self.pop();
                self.pop_pc();
            }

            // XCN A
            0x9F => {
                self.a = self.a.rotate_left(4);
                self.set_nz(self.a);
            }
            // MUL YA: N and Z reflect the high byte only.
            0xCF => {
                let product = u16::from(self.y) * u16::from(self.a);
                self.set_ya(product);
                self.set_nz(self.y);
            }
            // DIV YA,X
            0x9E => {
                let result = div_ya_x(self.ya(), self.x);
                self.a = result.a;
                self.y = result.y;
                self.set_flag(FLAG_V, result.v);
                self.set_flag(FLAG_H, result.h);
                self.set_nz(self.a);
            }
            // DAA A
            0xDF => {
                if self.carry() != 0 || self.a > 0x99 {
                    self.a = self.a.wrapping_add(0x60);
                    self.psw |= FLAG_C;
                }
                if self.psw & FLAG_H != 0 || self.a & 0x0F > 0x09 {
                    self.a = self.a.wrapping_add(0x06);
                }
                self.set_nz(self.a);
            }
            // DAS A
            0xBE => {
                if self.carry() == 0 || self.a > 0x99 {
                    self.a = self.a.wrapping_sub(0x60);
                    self.psw &= !FLAG_C;
                }
                if self.psw & FLAG_H == 0 || self.a & 0x0F > 0x09 {
                    self.a = self.a.wrapping_sub(0x06);
                }
                self.set_nz(self.a);
            }

            // SLEEP / STOP: no interrupt source exists to wake the CPU.
            0xEF | 0xFF => {
                self.halted = true;
                cycles = 2;
            }
        }
        cycles
    }
}
