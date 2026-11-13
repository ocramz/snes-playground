//! PPU register capture: VRAM, CGRAM and OAM with their port semantics, and
//! every `$2100-$2133` register stored. No pixels are produced.
//!
//! Port behaviour follows fullsnes, "SNES Memory VRAM/CGRAM/OAM Access" and
//! "SNES PPU BG Control" (write-twice formulas quoted at each site).

/// Number of `$21xx` registers tracked per line (`$2100-$2133`).
pub const NREGS: usize = 0x34;

/// Which memory a data-port write landed in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    Vram,
    Cgram,
    Oam,
}

impl Target {
    pub fn name(self) -> &'static str {
        match self {
            Target::Vram => "vram",
            Target::Cgram => "cgram",
            Target::Oam => "oam",
        }
    }
}

/// Where a data-port write went: memory, the address in that memory's own
/// units (VRAM word, CGRAM colour, OAM byte), and whether it was dropped.
#[derive(Clone, Copy, Debug)]
pub struct PortWrite {
    pub target: Target,
    pub addr: u32,
    pub dropped: bool,
}

pub struct Ppu {
    pub vram: Vec<u8>,
    pub cgram: [u8; 512],
    pub oam: [u8; 544],

    /// Last byte written to each `$2100-$2133` register.
    pub raw: [u8; NREGS],
    /// Composed value of each register: write-twice registers hold the full
    /// 10/13/16-bit value, the rest their byte.
    pub cur: [u16; NREGS],

    // VRAM port.
    pub vmain: u8,
    pub vaddr: u16,
    vprefetch: u16,
    // CGRAM port: byte address 0..511.
    cg_addr: u16,
    cg_lsb: u8,
    // OAM port.
    oam_reload: u16,
    pub oam_addr: u16,
    oam_lsb: u8,
    // Write-twice latches.
    bg_old: u8,
    m7_old: u8,
    pub m7hofs: u16,
    pub m7vofs: u16,
    pub coldata: [u8; 3],
    mpy: i32,
    // Counters.
    pub hcount_latch: u16,
    pub vcount_latch: u16,
    ophct_flip: bool,
    opvct_flip: bool,
    latch_flag: bool,
    pub ppu1_mdr: u8,
    pub ppu2_mdr: u8,

    /// Writes refused because the display was active (VRAM only, as on
    /// hardware), and CGRAM/OAM writes made outside blanking (kept, counted).
    pub vram_blocked: u64,
    pub cgram_active_writes: u64,
    pub oam_active_writes: u64,
}

impl Ppu {
    pub fn new() -> Self {
        Self {
            vram: vec![0; 0x10000],
            cgram: [0; 512],
            oam: [0; 544],
            raw: [0; NREGS],
            cur: [0; NREGS],
            vmain: 0,
            vaddr: 0,
            vprefetch: 0,
            cg_addr: 0,
            cg_lsb: 0,
            oam_reload: 0,
            oam_addr: 0,
            oam_lsb: 0,
            bg_old: 0,
            m7_old: 0,
            m7hofs: 0,
            m7vofs: 0,
            coldata: [0; 3],
            mpy: 0,
            hcount_latch: 0,
            vcount_latch: 0,
            ophct_flip: false,
            opvct_flip: false,
            latch_flag: false,
            ppu1_mdr: 0,
            ppu2_mdr: 0,
            vram_blocked: 0,
            cgram_active_writes: 0,
            oam_active_writes: 0,
        }
    }

    pub fn forced_blank(&self) -> bool {
        self.raw[0] & 0x80 != 0
    }

    /// VMAIN address translation (fullsnes: "thrice left-rotate the lower
    /// 8, 9, or 10 bits"), then bit 15 dropped (only 32K words installed).
    fn vram_remap(&self) -> u16 {
        let a = self.vaddr;
        let r = match (self.vmain >> 2) & 3 {
            0 => a,
            1 => (a & 0xFF00) | ((a & 0x001F) << 3) | ((a >> 5) & 7),
            2 => (a & 0xFE00) | ((a & 0x003F) << 3) | ((a >> 6) & 7),
            _ => (a & 0xFC00) | ((a & 0x007F) << 3) | ((a >> 7) & 7),
        };
        r & 0x7FFF
    }

    fn vram_step(&self) -> u16 {
        match self.vmain & 3 {
            0 => 1,
            1 => 32,
            _ => 128,
        }
    }

    fn vram_word(&self, w: u16) -> u16 {
        let i = usize::from(w) * 2;
        u16::from_le_bytes([self.vram[i], self.vram[i + 1]])
    }

    /// `mul_m7`: M7A (signed 16) times the high byte of M7B (signed 8),
    /// readable at `$2134-$2136`.
    fn update_mpy(&mut self) {
        let a = i32::from(self.cur[0x1B] as i16);
        let b = i32::from((self.cur[0x1C] >> 8) as u8 as i8);
        self.mpy = a * b;
    }

    /// Latch the H/V counters (`$2137` read, or `$4201` bit 7 falling).
    pub fn latch_counters(&mut self, h: u16, v: u16) {
        self.hcount_latch = h;
        self.vcount_latch = v;
        self.latch_flag = true;
    }

    /// Reload the OAM address at the start of vblank (fullsnes: "at begin of
    /// line 225, but only if not in Forced Blank mode").
    pub fn vblank_oam_reload(&mut self) {
        if !self.forced_blank() {
            self.oam_addr = (self.oam_reload << 1) & 0x3FF;
        }
    }

    /// Write `$2100 + reg`. `active` is true while the PPU is drawing (not
    /// forced blank, lines 0-224); VRAM writes are then dropped.
    pub fn write(&mut self, reg: u8, v: u8, active: bool) -> Option<PortWrite> {
        let r = usize::from(reg);
        let prev = if r < NREGS { self.cur[r] } else { 0 };
        if r < NREGS {
            self.raw[r] = v;
            self.cur[r] = u16::from(v);
        }
        match reg {
            0x02 => {
                self.oam_reload = (self.oam_reload & 0x100) | u16::from(v);
                self.oam_addr = (self.oam_reload << 1) & 0x3FF;
            }
            0x03 => {
                self.oam_reload = (self.oam_reload & 0xFF) | (u16::from(v & 1) << 8);
                self.oam_addr = (self.oam_reload << 1) & 0x3FF;
            }
            0x04 => {
                // fullsnes: even -> latch; odd <200h -> word[addr-1]; >1FFh ->
                // byte (220h-3FFh mirror 200h-21Fh).
                let a = self.oam_addr;
                if active {
                    self.oam_active_writes += 1;
                }
                if a >= 0x200 {
                    self.oam[0x200 + usize::from(a & 0x1F)] = v;
                } else if a & 1 == 0 {
                    self.oam_lsb = v;
                } else {
                    self.oam[usize::from(a - 1)] = self.oam_lsb;
                    self.oam[usize::from(a)] = v;
                }
                self.oam_addr = (a + 1) & 0x3FF;
                return Some(PortWrite {
                    target: Target::Oam,
                    addr: u32::from(a),
                    dropped: false,
                });
            }
            0x0D..=0x14 => {
                let cur = prev;
                let val = if reg & 1 == 1 {
                    // BGnHOFS = (Current<<8) | (Prev&~7) | ((Reg>>8)&7)
                    (u16::from(v) << 8) | u16::from(self.bg_old & !7) | ((cur >> 8) & 7)
                } else {
                    // BGnVOFS = (Current<<8) | Prev
                    (u16::from(v) << 8) | u16::from(self.bg_old)
                };
                self.cur[r] = val & 0x3FF;
                self.bg_old = v;
                if reg == 0x0D {
                    self.m7hofs = ((u16::from(v) << 8) | u16::from(self.m7_old)) & 0x1FFF;
                    self.m7_old = v;
                } else if reg == 0x0E {
                    self.m7vofs = ((u16::from(v) << 8) | u16::from(self.m7_old)) & 0x1FFF;
                    self.m7_old = v;
                }
            }
            0x15 => self.vmain = v,
            0x16 => {
                self.vaddr = (self.vaddr & 0xFF00) | u16::from(v);
                self.vprefetch = self.vram_word(self.vram_remap());
            }
            0x17 => {
                self.vaddr = (self.vaddr & 0x00FF) | (u16::from(v) << 8);
                self.vprefetch = self.vram_word(self.vram_remap());
            }
            0x18 | 0x19 => {
                let w = self.vram_remap();
                let high = reg == 0x19;
                if active {
                    self.vram_blocked += 1;
                } else {
                    self.vram[usize::from(w) * 2 + usize::from(high)] = v;
                }
                if high == (self.vmain & 0x80 != 0) {
                    self.vaddr = self.vaddr.wrapping_add(self.vram_step());
                }
                return Some(PortWrite {
                    target: Target::Vram,
                    addr: u32::from(w),
                    dropped: active,
                });
            }
            0x1B..=0x20 => {
                self.cur[r] = (u16::from(v) << 8) | u16::from(self.m7_old);
                self.m7_old = v;
                if reg == 0x1B || reg == 0x1C {
                    self.update_mpy();
                }
            }
            0x21 => {
                self.cg_addr = u16::from(v) << 1;
            }
            0x22 => {
                let a = self.cg_addr;
                if active {
                    self.cgram_active_writes += 1;
                }
                if a & 1 == 0 {
                    self.cg_lsb = v;
                } else {
                    self.cgram[usize::from(a - 1)] = self.cg_lsb;
                    self.cgram[usize::from(a)] = v & 0x7F;
                }
                self.cg_addr = (a + 1) & 0x1FF;
                return Some(PortWrite {
                    target: Target::Cgram,
                    addr: u32::from(a >> 1),
                    dropped: false,
                });
            }
            0x32 => {
                let i = v & 0x1F;
                if v & 0x20 != 0 {
                    self.coldata[0] = i;
                }
                if v & 0x40 != 0 {
                    self.coldata[1] = i;
                }
                if v & 0x80 != 0 {
                    self.coldata[2] = i;
                }
            }
            _ => {}
        }
        None
    }

    /// Read `$2100 + reg` (only `$2134-$213F` are readable). `open` is the
    /// CPU open-bus value; counters are passed for `$2137`.
    pub fn read(&mut self, reg: u8, open: u8, h: u16, v: u16, wrio_bit7: bool) -> u8 {
        match reg {
            0x34 => self.mpy as u8,
            0x35 => (self.mpy >> 8) as u8,
            0x36 => (self.mpy >> 16) as u8,
            0x37 => {
                if wrio_bit7 {
                    self.latch_counters(h, v);
                }
                open
            }
            0x38 => {
                let a = self.oam_addr;
                let val = if a >= 0x200 {
                    self.oam[0x200 + usize::from(a & 0x1F)]
                } else {
                    self.oam[usize::from(a)]
                };
                self.oam_addr = (a + 1) & 0x3FF;
                self.ppu1_mdr = val;
                val
            }
            0x39 | 0x3A => {
                let high = reg == 0x3A;
                let val = if high {
                    (self.vprefetch >> 8) as u8
                } else {
                    self.vprefetch as u8
                };
                // fullsnes: prefetch from the OLD address, then increment.
                if high == (self.vmain & 0x80 != 0) {
                    self.vprefetch = self.vram_word(self.vram_remap());
                    self.vaddr = self.vaddr.wrapping_add(self.vram_step());
                }
                self.ppu1_mdr = val;
                val
            }
            0x3B => {
                let a = self.cg_addr;
                let val = if a & 1 == 1 {
                    (self.cgram[usize::from(a)] & 0x7F) | (self.ppu2_mdr & 0x80)
                } else {
                    self.cgram[usize::from(a)]
                };
                self.cg_addr = (a + 1) & 0x1FF;
                self.ppu2_mdr = val;
                val
            }
            0x3C => {
                let val = if self.ophct_flip {
                    ((self.hcount_latch >> 8) as u8 & 1) | (self.ppu2_mdr & 0xFE)
                } else {
                    self.hcount_latch as u8
                };
                self.ophct_flip = !self.ophct_flip;
                self.ppu2_mdr = val;
                val
            }
            0x3D => {
                let val = if self.opvct_flip {
                    ((self.vcount_latch >> 8) as u8 & 1) | (self.ppu2_mdr & 0xFE)
                } else {
                    self.vcount_latch as u8
                };
                self.opvct_flip = !self.opvct_flip;
                self.ppu2_mdr = val;
                val
            }
            0x3E => {
                let val = (self.ppu1_mdr & 0x10) | 0x01;
                self.ppu1_mdr = val;
                val
            }
            0x3F => {
                let val = (self.ppu2_mdr & 0x20) | (u8::from(self.latch_flag) << 6) | 0x03;
                self.latch_flag = false;
                self.ophct_flip = false;
                self.opvct_flip = false;
                self.ppu2_mdr = val;
                val
            }
            _ => open,
        }
    }

    // --- save state ---------------------------------------------------
    pub fn save(&self, w: &mut crate::state::Writer) {
        w.bytes(&self.vram);
        w.bytes(&self.cgram);
        w.bytes(&self.oam);
        w.bytes(&self.raw);
        for &c in &self.cur {
            w.u16(c);
        }
        w.u8(self.vmain);
        w.u16(self.vaddr);
        w.u16(self.vprefetch);
        w.u16(self.cg_addr);
        w.u8(self.cg_lsb);
        w.u16(self.oam_reload);
        w.u16(self.oam_addr);
        w.u8(self.oam_lsb);
        w.u8(self.bg_old);
        w.u8(self.m7_old);
        w.u16(self.m7hofs);
        w.u16(self.m7vofs);
        w.bytes(&self.coldata);
        w.u32(self.mpy as u32);
    }

    pub fn load(&mut self, r: &mut crate::state::Reader) {
        r.bytes(&mut self.vram);
        r.bytes(&mut self.cgram);
        r.bytes(&mut self.oam);
        r.bytes(&mut self.raw);
        for c in self.cur.iter_mut() {
            *c = r.u16();
        }
        self.vmain = r.u8();
        self.vaddr = r.u16();
        self.vprefetch = r.u16();
        self.cg_addr = r.u16();
        self.cg_lsb = r.u8();
        self.oam_reload = r.u16();
        self.oam_addr = r.u16();
        self.oam_lsb = r.u8();
        self.bg_old = r.u8();
        self.m7_old = r.u8();
        self.m7hofs = r.u16();
        self.m7vofs = r.u16();
        r.bytes(&mut self.coldata);
        self.mpy = r.u32() as i32;
    }
}
