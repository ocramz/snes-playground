//! Built-in checks, run by `spcrender --selftest` and by `cargo test`.
//!
//! These pin down behaviour that has an answer derivable by hand or from a
//! second formulation: instruction results and flags, cycle counts, timer
//! periods, every envelope/noise rate, BRR decoding through the Gaussian
//! kernel, and the echo ring. They do not replace the three validations in
//! docs/audio.md, which compare whole renders against independent models.

use crate::apu::Apu;
use crate::cpu::{div_ya_x, DivResult, FLAG_B, FLAG_C, FLAG_H, FLAG_N, FLAG_V, FLAG_Z};
use crate::dsp::Dsp;
use crate::tables::{COUNTER_RANGE, CYCLES, GAUSS, RATE_PERIOD};

const ORIGIN: u16 = 0x0200;
const STOP: u8 = 0xFF;

struct Report {
    failed: usize,
    total: usize,
}

impl Report {
    fn check(&mut self, name: &str, ok: bool, detail: impl FnOnce() -> String) {
        self.total += 1;
        if ok {
            println!("ok    {name}");
        } else {
            self.failed += 1;
            println!("FAIL  {name}: {}", detail());
        }
    }
}

/// Load `program` at `$0200`, apply `setup`, and run until STOP.
/// Returns the machine and the cycles spent before the STOP.
fn exec(program: &[u8], setup: impl FnOnce(&mut Apu)) -> (Apu, u32) {
    let mut apu = Apu::new();
    let start = usize::from(ORIGIN);
    apu.ram[start..start + program.len()].copy_from_slice(program);
    apu.pc = ORIGIN;
    setup(&mut apu);
    let mut cycles = 0;
    for _ in 0..10_000 {
        let step = apu.step();
        if apu.halted {
            break;
        }
        cycles += step;
    }
    (apu, cycles)
}

fn flags(apu: &Apu, mask: u8) -> u8 {
    apu.psw & mask
}

/// The closed-form description of `DIV YA,X` used by other emulators: plain
/// division while the quotient fits in nine bits, a fixed distortion when it
/// does not.
fn div_closed_form(ya: u16, x: u8) -> DivResult {
    let y = u32::from(ya >> 8);
    let (ya, x) = (u32::from(ya), u32::from(x));
    let (a, rem) = if y < (x << 1) {
        (ya / x, ya % x)
    } else {
        let over = ya - (x << 9);
        (255 - over / (256 - x), x + over % (256 - x))
    };
    DivResult {
        a: a as u8,
        y: rem as u8,
        v: y >= x,
        h: (y & 0x0F) >= (x & 0x0F),
    }
}

fn cpu_checks(r: &mut Report) {
    let (apu, _) = exec(&[0xE8, 0x7F, 0x60, 0x88, 0x01, STOP], |_| {});
    r.check(
        "ADC $7F+$01 sets N, V, H and clears C, Z",
        apu.a == 0x80
            && flags(&apu, FLAG_N | FLAG_V | FLAG_H | FLAG_C | FLAG_Z) == FLAG_N | FLAG_V | FLAG_H,
        || format!("A={:02X} PSW={:02X}", apu.a, apu.psw),
    );

    let (apu, _) = exec(&[0xE8, 0x10, 0x80, 0xA8, 0x01, STOP], |_| {});
    r.check(
        "SBC $10-$01 leaves C set (no borrow) and H clear (half borrow)",
        apu.a == 0x0F && flags(&apu, FLAG_C | FLAG_H | FLAG_V | FLAG_N | FLAG_Z) == FLAG_C,
        || format!("A={:02X} PSW={:02X}", apu.a, apu.psw),
    );

    let (apu, _) = exec(&[0xE8, 0x05, 0x68, 0x06, STOP], |_| {});
    r.check(
        "CMP $05,$06 clears C, sets N, keeps A",
        apu.a == 0x05 && flags(&apu, FLAG_C | FLAG_N | FLAG_Z) == FLAG_N,
        || format!("A={:02X} PSW={:02X}", apu.a, apu.psw),
    );

    let (apu, _) = exec(&[0x8D, 0x12, 0xE8, 0x34, 0xCF, STOP], |_| {});
    r.check(
        "MUL $12*$34 = $03A8",
        apu.y == 0x03 && apu.a == 0xA8,
        || format!("YA={:02X}{:02X}", apu.y, apu.a),
    );

    let (apu, _) = exec(&[0x8D, 0x01, 0xE8, 0x00, 0xCD, 0x10, 0x9E, STOP], |_| {});
    r.check(
        "DIV $0100/$10 = $10 remainder 0, V clear",
        apu.a == 0x10 && apu.y == 0 && flags(&apu, FLAG_V) == 0,
        || format!("A={:02X} Y={:02X} PSW={:02X}", apu.a, apu.y, apu.psw),
    );

    let (apu, _) = exec(&[0xE8, 0x19, 0x60, 0x88, 0x28, 0xDF, STOP], |_| {});
    r.check("DAA after $19+$28 gives $47", apu.a == 0x47, || {
        format!("A={:02X}", apu.a)
    });

    let (apu, _) = exec(&[0xE8, 0x41, 0x80, 0xA8, 0x28, 0xBE, STOP], |_| {});
    r.check("DAS after $41-$28 gives $13", apu.a == 0x13, || {
        format!("A={:02X}", apu.a)
    });

    let (apu, _) = exec(&[0xE8, 0xA5, 0x9F, STOP], |_| {});
    r.check("XCN $A5 = $5A", apu.a == 0x5A, || {
        format!("A={:02X}", apu.a)
    });

    let (apu, _) = exec(
        &[
            0xCD, 0xEF, 0xBD, 0x3F, 0x0A, 0x02, 0xE8, 0x22, STOP, 0x00, 0x8D, 0x33, 0x6F,
        ],
        |_| {},
    );
    r.check(
        "CALL pushes the return address high byte first, RET restores it",
        apu.a == 0x22
            && apu.y == 0x33
            && apu.sp == 0xEF
            && apu.ram[0x01EF] == 0x02
            && apu.ram[0x01EE] == 0x06,
        || {
            format!(
                "A={:02X} Y={:02X} SP={:02X} stack={:02X} {:02X}",
                apu.a, apu.y, apu.sp, apu.ram[0x01EF], apu.ram[0x01EE]
            )
        },
    );

    let (apu, _) = exec(
        &[
            0x8F, 0xFF, 0x10, 0x8F, 0x00, 0x11, 0x3A, 0x10, 0xBA, 0x10, 0x7A, 0x10, 0x9A, 0x10,
            0x5A, 0x10, 0x1A, 0x10, STOP,
        ],
        |_| {},
    );
    r.check(
        "INCW/MOVW/ADDW/SUBW/CMPW/DECW on a direct-page word",
        apu.y == 0x01
            && apu.a == 0x00
            && apu.ram[0x10] == 0xFF
            && apu.ram[0x11] == 0x00
            && flags(&apu, FLAG_C | FLAG_Z) == FLAG_C,
        || {
            format!(
                "YA={:02X}{:02X} word={:02X}{:02X} PSW={:02X}",
                apu.y, apu.a, apu.ram[0x11], apu.ram[0x10], apu.psw
            )
        },
    );

    let (apu, _) = exec(
        &[
            0x8F, 0x00, 0x20, 0x62, 0x20, 0x80, 0xCA, 0x20, 0xE0, 0x60, 0x0A, 0x20, 0x60, 0xEA,
            0x20, 0x00, STOP,
        ],
        |_| {},
    );
    r.check(
        "SET1, MOV1 m.b,C, OR1 C,m.b and NOT1 address 13-bit memory bits",
        apu.ram[0x20] == 0x89 && flags(&apu, FLAG_C) == FLAG_C,
        || format!("[$20]={:02X} PSW={:02X}", apu.ram[0x20], apu.psw),
    );

    let (apu, cycles) = exec(&[0x8D, 0x03, 0xFE, 0xFE, STOP], |_| {});
    r.check(
        "DBNZ Y loop of three costs 2 + 6 + 6 + 4 cycles",
        cycles == 18 && apu.y == 0,
        || format!("cycles={cycles} Y={:02X}", apu.y),
    );

    let (apu, _) = exec(&[0x40, 0x8F, 0xAB, 0x10, 0x20, STOP], |_| {});
    r.check(
        "SETP moves the direct page to $01xx",
        apu.ram[0x0110] == 0xAB && apu.ram[0x0010] == 0,
        || {
            format!(
                "[$0110]={:02X} [$0010]={:02X}",
                apu.ram[0x0110], apu.ram[0x0010]
            )
        },
    );

    let (apu, _) = exec(
        &[
            0x8F, 0x00, 0x30, 0x8F, 0x03, 0x31, 0x8D, 0x05, 0xE8, 0x77, 0xD7, 0x30, 0xCD, 0x02,
            0xE8, 0x00, 0xE7, 0x2E, STOP,
        ],
        |apu| apu.ram[0x0300] = 0x42,
    );
    r.check(
        "MOV [d]+Y,A and MOV A,[d+X] follow the direct-page pointer",
        apu.ram[0x0305] == 0x77 && apu.a == 0x42,
        || format!("[$0305]={:02X} A={:02X}", apu.ram[0x0305], apu.a),
    );

    let (apu, _) = exec(
        &[
            0xE8, 0x0F, 0x0E, 0x00, 0x03, 0xE8, 0x03, 0x4E, 0x00, 0x03, STOP,
        ],
        |apu| {
            apu.ram[0x0300] = 0xF0;
        },
    );
    r.check(
        "TSET1 then TCLR1 on $F0 gives $FC",
        apu.ram[0x0300] == 0xFC,
        || format!("[$0300]={:02X}", apu.ram[0x0300]),
    );

    let (apu, _) = exec(
        &[
            0xE8, 0x05, 0x8F, 0x05, 0x40, 0x2E, 0x40, 0x02, 0xE8, 0x06, 0x2E, 0x40, 0x02, 0xE8,
            0xFF, 0x8F, 0x81, 0x41, 0xE3, 0x41, 0x02, 0xE8, 0xEE, 0x13, 0x41, 0x02, 0xCD, 0x11,
            STOP,
        ],
        |_| {},
    );
    r.check(
        "CBNE, BBS and BBC take the branch only when their condition holds",
        apu.a == 0x06 && apu.x == 0x11,
        || format!("A={:02X} X={:02X}", apu.a, apu.x),
    );

    let (apu, _) = exec(&[0xCD, 0xEF, 0xBD, 0x80, 0x0D, 0x60, 0x8E, STOP], |_| {});
    r.check(
        "PUSH PSW / POP PSW restores the carry",
        flags(&apu, FLAG_C) == FLAG_C,
        || format!("PSW={:02X}", apu.psw),
    );

    let (apu, _) = exec(&[0xCD, 0xEF, 0xBD, 0x01, STOP], |apu| {
        apu.ram[0xFFDE] = 0x00;
        apu.ram[0xFFDF] = 0x03;
        apu.ram[0x0300] = 0xE8;
        apu.ram[0x0301] = 0x99;
        apu.ram[0x0302] = 0x6F;
    });
    r.check(
        "TCALL 0 vectors through $FFDE",
        apu.a == 0x99 && apu.sp == 0xEF,
        || format!("A={:02X} SP={:02X}", apu.a, apu.sp),
    );

    let (apu, _) = exec(&[0xCD, 0xEF, 0xBD, 0x0F, STOP], |apu| {
        apu.ram[0xFFDE] = 0x00;
        apu.ram[0xFFDF] = 0x03;
        apu.ram[0x0300] = 0xE8;
        apu.ram[0x0301] = 0x77;
        apu.ram[0x0302] = 0x7F;
    });
    r.check(
        "BRK vectors through $FFDE and RETI restores PSW",
        apu.a == 0x77 && apu.sp == 0xEF && flags(&apu, FLAG_B) == 0,
        || format!("A={:02X} SP={:02X} PSW={:02X}", apu.a, apu.sp, apu.psw),
    );

    let (apu, _) = exec(
        &[
            0x8F, 0x80, 0xF1, 0xE5, 0xC0, 0xFF, 0x8F, 0x00, 0xF1, 0xE9, 0xC0, 0xFF, STOP,
        ],
        |apu| apu.ram[0xFFC0] = 0x5A,
    );
    r.check(
        "$F1 bit 7 maps the boot ROM over $FFC0 and unmaps it again",
        apu.a == 0xCD && apu.x == 0x5A,
        || format!("A={:02X} X={:02X}", apu.a, apu.x),
    );

    let (apu, _) = exec(&[0xCD, 0x02, 0x1F, 0x00, 0x03, STOP], |apu| {
        apu.ram[0x0302] = 0x10;
        apu.ram[0x0303] = 0x02;
        apu.ram[0x0210] = 0xE8;
        apu.ram[0x0211] = 0x44;
        apu.ram[0x0212] = STOP;
    });
    r.check(
        "JMP [!a+X] reads its target from the table",
        apu.a == 0x44,
        || format!("A={:02X}", apu.a),
    );

    let (apu, _) = exec(
        &[
            0xCD, 0x50, 0xE8, 0xAA, 0xAF, 0xE8, 0xBB, 0xAF, 0xCD, 0x50, 0xBF, 0xFD, 0xBF, STOP,
        ],
        |_| {},
    );
    r.check(
        "MOV (X)+,A and MOV A,(X)+ post-increment X",
        apu.ram[0x50] == 0xAA
            && apu.ram[0x51] == 0xBB
            && apu.y == 0xAA
            && apu.a == 0xBB
            && apu.x == 0x52,
        || {
            format!(
                "[$50]={:02X} [$51]={:02X} Y={:02X} A={:02X} X={:02X}",
                apu.ram[0x50], apu.ram[0x51], apu.y, apu.a, apu.x
            )
        },
    );

    let (apu, _) = exec(&[0xE8, 0x81, 0x1C, 0x3C, 0x5C, 0x7C, STOP], |_| {});
    r.check(
        "ASL, ROL, LSR, ROR pass bits through the carry",
        apu.a == 0x81 && flags(&apu, FLAG_C) == 0,
        || format!("A={:02X} PSW={:02X}", apu.a, apu.psw),
    );

    let (apu, _) = exec(
        &[
            0x8F, 0x10, 0x60, 0x8F, 0x20, 0x61, 0x60, 0x89, 0x60, 0x61, 0xCD, 0x60, 0x8D, 0x61,
            0x60, 0x99, 0x78, 0x40, 0x60, STOP,
        ],
        |_| {},
    );
    r.check(
        "ADC dd,ds stores source-first; ADC (X),(Y); CMP d,#i",
        apu.ram[0x60] == 0x40 && apu.ram[0x61] == 0x30 && flags(&apu, FLAG_Z) == FLAG_Z,
        || {
            format!(
                "[$60]={:02X} [$61]={:02X} PSW={:02X}",
                apu.ram[0x60], apu.ram[0x61], apu.psw
            )
        },
    );

    // DIV: the bit-serial divider against the closed form, every input.
    let mut mismatches = 0u32;
    let mut first = None;
    for ya in 0..=u16::MAX {
        for x in 0..=u8::MAX {
            let serial = div_ya_x(ya, x);
            if serial != div_closed_form(ya, x) {
                mismatches += 1;
                first.get_or_insert((ya, x, serial));
            }
        }
    }
    r.check(
        "DIV YA,X: bit-serial divider equals the closed form on all 2^24 inputs",
        mismatches == 0,
        || format!("{mismatches} mismatches, first {first:?}"),
    );

    let documented = CYCLES.iter().filter(|&&c| c != 0).count();
    r.check(
        "cycle table has a figure for every opcode but SLEEP and STOP",
        documented == 254,
        || format!("{documented} non-zero entries"),
    );
}

fn timer_checks(r: &mut Report) {
    // A halted CPU still lets time pass: 32 cycles per sample.
    let mut apu = Apu::new();
    apu.halted = true;
    apu.write(0x00FA, 2); // timer 0: 8 kHz / 2
    apu.write(0x00FC, 0); // timer 2: 64 kHz / 256
    apu.write(0x00F1, 0x05);
    for _ in 0..80 {
        apu.run_sample();
    }
    let t0 = apu.read(0x00FD);
    let t0_again = apu.read(0x00FD);
    r.check(
        "timer 0 with divider 2 counts once per 256 cycles and clears on read",
        t0 == 10 && t0_again == 0,
        || format!("read {t0} then {t0_again} after 2560 cycles"),
    );
    for _ in 0..(4096 * 3 / 32 - 80) {
        apu.run_sample();
    }
    let t2 = apu.read(0x00FF);
    r.check(
        "timer 2 with divider 0 (256) counts once per 4096 cycles",
        t2 == 3,
        || format!("read {t2} after 12288 cycles"),
    );
    let t1 = apu.read(0x00FE);
    r.check("a disabled timer stays at zero", t1 == 0, || {
        format!("read {t1}")
    });
}

/// A looping one-block sample (sixteen samples of `7 << 11`), directory at
/// `$0200`, voice 0 set up at pitch `$1000` with a direct GAIN of `$7F`.
fn constant_voice() -> Apu {
    let mut apu = Apu::new();
    apu.halted = true;
    apu.ram[0x0200..0x0204].copy_from_slice(&[0x00, 0x03, 0x00, 0x03]);
    apu.ram[0x0300] = 0xC3; // shift 12, filter 0, loop + end
    apu.ram[0x0301..0x0309].fill(0x77);
    let mut regs = [0u8; 128];
    regs[0x00] = 0x7F; // V0VOLL
    regs[0x01] = 0x7F; // V0VOLR
    regs[0x03] = 0x10; // pitch $1000
    regs[0x07] = 0x7F; // direct gain
    regs[0x0C] = 0x7F; // MVOLL
    regs[0x1C] = 0x7F; // MVOLR
    regs[0x5D] = 0x02; // DIR
    regs[0x6C] = 0x20; // FLG: running, echo writes off
    apu.dsp.load(&regs);
    apu
}

fn dsp_checks(r: &mut Report) {
    // Every rate: the noise generator steps exactly range/period times per
    // trip of the counter.
    let mut ram = Box::new([0u8; 0x10000]);
    let mut wrong = Vec::new();
    for (rate, &period) in RATE_PERIOD.iter().enumerate().skip(1) {
        let mut dsp = Dsp::new();
        dsp.write(0x6C, 0x60 | rate as u8);
        let mut steps = 0u32;
        let mut last = dsp.noise_level();
        for i in 0..u64::from(COUNTER_RANGE) {
            dsp.run_sample(&mut ram, i);
            if dsp.noise_level() != last {
                steps += 1;
                last = dsp.noise_level();
            }
        }
        let expect = COUNTER_RANGE / u32::from(period);
        if steps != expect {
            wrong.push((rate, steps, expect));
        }
    }
    r.check(
        "all 31 rates fire range/period times per counter cycle",
        wrong.is_empty(),
        || format!("(rate, got, expected): {wrong:?}"),
    );

    let sums: Vec<i32> = (0..256)
        .map(|i| {
            i32::from(GAUSS[255 - i])
                + i32::from(GAUSS[511 - i])
                + i32::from(GAUSS[256 + i])
                + i32::from(GAUSS[i])
        })
        .collect();
    let (lo, hi) = (
        sums.iter().min().copied().unwrap_or(0),
        sums.iter().max().copied().unwrap_or(0),
    );
    r.check(
        "Gaussian taps sum to $7FF..$801 at every phase",
        lo == 0x7FF && hi == 0x801,
        || format!("range {lo:#X}..{hi:#X}"),
    );

    // Key-on latency, envelope read-back and the steady-state level.
    let mut apu = constant_voice();
    apu.dsp.write(0x4C, 0x01);
    let out: Vec<(i16, i16)> = (0..64).map(|_| apu.run_sample()).collect();
    let first = out.iter().position(|&(l, _)| l != 0);
    r.check(
        "first audible sample is 8 samples after a key-on written at sample 0",
        first == Some(8),
        || format!("first non-zero at {first:?}"),
    );
    r.check(
        "direct GAIN $7F reads back as ENVX $7F (envelope $7F0)",
        apu.dsp.read(0x08) == 0x7F && apu.dsp.envelope(0) == 0x7F0,
        || {
            format!(
                "ENVX={:02X} env={:#X}",
                apu.dsp.read(0x08),
                apu.dsp.envelope(0)
            )
        },
    );
    // 7<<11 = 14336 through taps 370+1305+374, envelope $7F0, VOL and MVOL
    // $7F: 28686 -> 28460 -> 28237 -> 28016.
    r.check(
        "a constant BRR sample settles at the hand-computed level 28016",
        out[40] == (28016, 28016),
        || format!("got {:?}", out[40]),
    );
    r.check(
        "OUTX holds the high byte of the enveloped sample",
        apu.dsp.read(0x09) == (28460 >> 8) as u8,
        || format!("OUTX={:02X}", apu.dsp.read(0x09)),
    );

    // Attack rate 10 is rate 21: one +32 step per 20 samples, 63 steps to $7E0.
    let mut apu = constant_voice();
    apu.dsp.write(0x05, 0x8A);
    apu.dsp.write(0x06, 0xE0);
    apu.dsp.write(0x4C, 0x01);
    let mut start = None;
    let mut reached = None;
    for i in 0..4000u32 {
        apu.run_sample();
        let env = apu.dsp.envelope(0);
        if env > 0 && start.is_none() {
            start = Some(i);
        }
        if env >= 0x7E0 && reached.is_none() {
            reached = Some(i);
        }
    }
    let span = match (start, reached) {
        (Some(a), Some(b)) => b - a,
        _ => 0,
    };
    r.check(
        "ADSR attack rate 10 takes 62 steps of 20 samples from first step to $7E0",
        span == 62 * 20,
        || format!("start {start:?}, reached {reached:?}"),
    );

    // Key-off: release drops 8 per sample.
    let mut apu = constant_voice();
    apu.dsp.write(0x4C, 0x01);
    for _ in 0..40 {
        apu.run_sample();
    }
    apu.dsp.write(0x5C, 0x01);
    let mut samples_to_zero = 0u32;
    while apu.dsp.envelope(0) > 0 && samples_to_zero < 1000 {
        apu.run_sample();
        samples_to_zero += 1;
    }
    r.check(
        "release from $7F0 reaches zero in 254 steps (plus up to 2 samples of KOFF polling)",
        (254..=256).contains(&samples_to_zero) && apu.dsp.voices_idle(),
        || format!("{samples_to_zero} samples"),
    );

    // Echo: one entry of $4000 in a 512-sample ring, FIR7 (newest tap) $7F,
    // echo volume $7F, writes disabled so the entry stays put.
    let mut apu = Apu::new();
    apu.halted = true;
    apu.ram[0x4000] = 0x00;
    apu.ram[0x4001] = 0x40;
    let mut regs = [0u8; 128];
    regs[0x2C] = 0x7F; // EVOLL
    regs[0x6C] = 0x20;
    regs[0x6D] = 0x40; // ESA
    regs[0x7D] = 0x01; // EDL: 2 KB
    regs[0x7F] = 0x7F; // FIR7
    apu.dsp.load(&regs);
    let out: Vec<i16> = (0..1030).map(|_| apu.run_sample().0).collect();
    let hits: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, &s)| s != 0)
        .map(|(i, _)| i)
        .collect();
    r.check(
        "echo ring of EDL=1 is 512 samples and FIR7 is the newest tap",
        hits == [0, 512, 1024] && out[0] == 16129,
        || format!("non-zero at {hits:?}, value {}", out[0]),
    );
    regs[0x7F] = 0x00;
    regs[0x0F] = 0x7F; // FIR0: the oldest tap
    let mut apu = Apu::new();
    apu.halted = true;
    apu.ram[0x4001] = 0x40;
    apu.dsp.load(&regs);
    let out: Vec<i16> = (0..16).map(|_| apu.run_sample().0).collect();
    let first = out.iter().position(|&s| s != 0);
    r.check(
        "FIR0 is the oldest tap, seven samples behind FIR7",
        first == Some(7),
        || format!("first non-zero at {first:?}"),
    );
}

/// Two looping one-block samples, constant `7 << 11` at `$0300` (SRCN 0) and
/// `3 << 11` at `$0310` (SRCN 1). Voice 0 plays SRCN 0 and voice 1 SRCN 1,
/// both at half volume so that their sum never saturates. Nothing is keyed on.
fn two_voices() -> Apu {
    let mut apu = Apu::new();
    apu.halted = true;
    apu.ram[0x0200..0x0208].copy_from_slice(&[0x00, 0x03, 0x00, 0x03, 0x10, 0x03, 0x10, 0x03]);
    apu.ram[0x0300] = 0xC3;
    apu.ram[0x0301..0x0309].fill(0x77);
    apu.ram[0x0310] = 0xC3;
    apu.ram[0x0311..0x0319].fill(0x33);
    let mut regs = [0u8; 128];
    for base in [0x00, 0x10] {
        regs[base] = 0x3F; // VOLL
        regs[base + 1] = 0x3F; // VOLR
        regs[base + 3] = 0x10; // pitch $1000
        regs[base + 7] = 0x7F; // direct gain
    }
    regs[0x14] = 0x01; // V1SRCN
    regs[0x0C] = 0x7F;
    regs[0x1C] = 0x7F;
    regs[0x5D] = 0x02;
    regs[0x6C] = 0x20;
    apu.dsp.load(&regs);
    apu
}

/// Key both voices of `two_voices` on, switch voice 0 to SRCN 1 and key it on
/// again at sample 40, and return 120 samples of the left channel.
fn two_voices_run(setup: impl FnOnce(&mut Apu)) -> (Apu, Vec<i16>) {
    let mut apu = two_voices();
    setup(&mut apu);
    apu.dsp.write(0x4C, 0x03);
    let mut out = Vec::new();
    for i in 0..120 {
        if i == 40 {
            apu.dsp.write(0x04, 0x01);
            apu.dsp.write(0x4C, 0x01);
        }
        out.push(apu.run_sample().0);
    }
    (apu, out)
}

/// Voice 0 of `constant_voice` sent to an echo ring at `$4000` (EDL 1, FIR7
/// `$7F`, EVOL `$7F`, no feedback) with echo writes on. Returns the left
/// channel over two trips of the ring and the machine.
fn echo_run(setup: impl FnOnce(&mut Apu)) -> (Apu, Vec<i16>) {
    let mut apu = constant_voice();
    apu.dsp.write(0x00, 0x20); // V0VOLL low enough that dry + echo fits
    apu.dsp.write(0x2C, 0x7F); // EVOLL
    apu.dsp.write(0x4D, 0x01); // EON: voice 0
    apu.dsp.write(0x6D, 0x40); // ESA
    apu.dsp.write(0x7D, 0x01); // EDL
    apu.dsp.write(0x7F, 0x7F); // FIR7
    apu.dsp.write(0x6C, 0x00); // FLG: echo writes on
    setup(&mut apu);
    apu.dsp.write(0x4C, 0x01);
    let out = (0..1100).map(|_| apu.run_sample().0).collect();
    (apu, out)
}

fn stem_checks(r: &mut Report) {
    // Soloing a source, against muting by voice. Before sample 40 voice 0
    // plays $0300 and voice 1 $0310; after voice 0's second key-on both play
    // $0310.
    let (full_apu, full) = two_voices_run(|_| {});
    let (_, only_v0) = two_voices_run(|apu| apu.dsp.mute_mask = 0x02);
    let (_, only_v1) = two_voices_run(|apu| apu.dsp.mute_mask = 0x01);
    let (solo_a_apu, solo_a) = two_voices_run(|apu| apu.dsp.solo_sources = vec![0x0300]);
    let (_, solo_b) = two_voices_run(|apu| apu.dsp.solo_sources = vec![0x0310]);
    let (_, solo_ab) = two_voices_run(|apu| apu.dsp.solo_sources = vec![0x0300, 0x0310]);
    r.check(
        "--solo-source follows the sample, not the voice, across a key-on",
        solo_a[..40] == only_v0[..40]
            && solo_a[60..].iter().all(|&s| s == 0)
            && solo_b[..40] == only_v1[..40]
            && solo_b[60..] == full[60..]
            && solo_a[30] != 0
            && solo_ab == full,
        || {
            format!(
                "solo $0300 at 30/100: {}/{}, voice 0 alone at 30: {}; \
                 solo $0310 at 30/100: {}/{}, full at 100: {}",
                solo_a[30], solo_a[100], only_v0[30], solo_b[30], solo_b[100], full[100]
            )
        },
    );
    // MVOL scales the summed voices once, then floors: two stems floored
    // separately can come out 1 below the mix.
    let worst = (0..full.len())
        .map(|i| i32::from(full[i]) - i32::from(solo_a[i]) - i32::from(solo_b[i]))
        .fold((0, 0), |(lo, hi), d| (d.min(lo), d.max(hi)));
    r.check(
        "solo renders of every source add up to the mix, within the MVOL floor",
        worst.0 >= 0 && worst.1 <= 1,
        || format!("mix minus sum ranges {worst:?}"),
    );
    r.check(
        "a voice left out by --solo-source still runs: ENVX and OUTX as unmuted",
        solo_a_apu.dsp.read(0x18) == 0x7F && solo_a_apu.dsp.read(0x19) != 0,
        || {
            format!(
                "V1 ENVX={:02X} OUTX={:02X}",
                solo_a_apu.dsp.read(0x18),
                solo_a_apu.dsp.read(0x19)
            )
        },
    );

    // The saturation counters: the two half-volume voices fit, at full volume
    // their sum does not.
    let (loud_apu, _) = two_voices_run(|apu| {
        for reg in [0x00, 0x01, 0x10, 0x11] {
            apu.dsp.write(reg, 0x7F);
        }
    });
    let (quiet, loud) = (full_apu.dsp.saturated, loud_apu.dsp.saturated);
    r.check(
        "saturation counters: none at half volume, the main sum clamps at full",
        quiet.main + quiet.echo + quiet.output == 0
            && loud.main >= 30
            && loud.echo + loud.output == 0,
        || format!("half {quiet:?}, full {loud:?}"),
    );

    // --no-echo: the output loses the echo return and nothing else.
    let (wet_apu, wet) = echo_run(|_| {});
    let (dry_apu, dry) = echo_run(|apu| apu.dsp.no_echo = true);
    let (_, unechoed) = echo_run(|apu| apu.dsp.write(0x2C, 0x00));
    r.check(
        "--no-echo drops the echo return but writes the echo ring the same",
        dry == unechoed && wet != dry && wet_apu.ram[0x4000..0x4800] == dry_apu.ram[0x4000..0x4800],
        || {
            format!(
                "at 600: wet {} dry {} EVOL 0 {}",
                wet[600], dry[600], unechoed[600]
            )
        },
    );
}

/// Run every check, print one line each, and return how many failed.
pub fn run() -> usize {
    let mut report = Report {
        failed: 0,
        total: 0,
    };
    cpu_checks(&mut report);
    timer_checks(&mut report);
    dsp_checks(&mut report);
    stem_checks(&mut report);
    println!("{} checks, {} failed", report.total, report.failed);
    report.failed
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_selftest_check_passes() {
        assert_eq!(super::run(), 0, "spcrender --selftest reported failures");
    }
}
