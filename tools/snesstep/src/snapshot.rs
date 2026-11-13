//! Snapshot directories: `vram.bin`, `cgram.bin`, `oam.bin`, `wram.bin`,
//! `regs.json`. The layout is fixed (tools/ppu_render.py reads it).

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::Path;

use crate::bus::fmt_snes;
use crate::cpu::Cpu;
use crate::ppu::NREGS;

fn sext(v: u16, bits: u32) -> i32 {
    let shift = 32 - bits;
    ((u32::from(v) << shift) as i32) >> shift
}

fn list(vals: &[i64]) -> String {
    let parts: Vec<String> = vals.iter().map(|v| v.to_string()).collect();
    format!("[{}]", parts.join(", "))
}

pub fn regs_json(cpu: &Cpu, reason: &str) -> String {
    let b = &cpu.bus;
    let p = &b.ppu;
    let raw = |r: usize| i64::from(p.raw[r]);
    let cur = |r: usize| i64::from(p.cur[r]);
    let mut s = String::new();
    s.push_str("{\n");
    let _ = writeln!(s, "  \"frame\": {},", b.frame);
    let _ = writeln!(s, "  \"pc\": \"{}\",", fmt_snes(cpu.pc24()));
    let _ = writeln!(s, "  \"scanline\": {},", b.vline);
    let _ = writeln!(s, "  \"reason\": \"{}\",", reason);
    let _ = writeln!(
        s,
        "  \"cpu\": {{\"a\": \"{:04X}\", \"x\": \"{:04X}\", \"y\": \"{:04X}\", \"s\": \"{:04X}\", \"d\": \"{:04X}\", \"db\": \"{:02X}\", \"p\": \"{:02X}\", \"e\": {}}},",
        cpu.a, cpu.x, cpu.y, cpu.s, cpu.d, cpu.db, cpu.p, cpu.e
    );
    s.push_str("  \"ppu\": {\n");
    let m7 = |r: usize| i64::from(sext(p.cur[r], 16));
    let m7xy = |r: usize| i64::from(sext(p.cur[r], 13));
    let fields: Vec<(String, String)> = vec![
        ("inidisp".into(), raw(0x00).to_string()),
        ("obsel".into(), raw(0x01).to_string()),
        ("bgmode".into(), raw(0x05).to_string()),
        ("mosaic".into(), raw(0x06).to_string()),
        (
            "bg_sc".into(),
            list(&[raw(0x07), raw(0x08), raw(0x09), raw(0x0A)]),
        ),
        ("bg_nba".into(), list(&[raw(0x0B), raw(0x0C)])),
        (
            "bg_hofs".into(),
            list(&[cur(0x0D), cur(0x0F), cur(0x11), cur(0x13)]),
        ),
        (
            "bg_vofs".into(),
            list(&[cur(0x0E), cur(0x10), cur(0x12), cur(0x14)]),
        ),
        ("m7sel".into(), raw(0x1A).to_string()),
        (
            "m7".into(),
            format!(
                "{{\"a\": {}, \"b\": {}, \"c\": {}, \"d\": {}, \"x\": {}, \"y\": {}}}",
                m7(0x1B),
                m7(0x1C),
                m7(0x1D),
                m7(0x1E),
                m7xy(0x1F),
                m7xy(0x20)
            ),
        ),
        ("m7hofs".into(), sext(p.m7hofs, 13).to_string()),
        ("m7vofs".into(), sext(p.m7vofs, 13).to_string()),
        ("w12sel".into(), raw(0x23).to_string()),
        ("w34sel".into(), raw(0x24).to_string()),
        ("wobjsel".into(), raw(0x25).to_string()),
        (
            "wh".into(),
            list(&[raw(0x26), raw(0x27), raw(0x28), raw(0x29)]),
        ),
        ("wbglog".into(), raw(0x2A).to_string()),
        ("wobjlog".into(), raw(0x2B).to_string()),
        ("tm".into(), raw(0x2C).to_string()),
        ("ts".into(), raw(0x2D).to_string()),
        ("tmw".into(), raw(0x2E).to_string()),
        ("tsw".into(), raw(0x2F).to_string()),
        ("cgwsel".into(), raw(0x30).to_string()),
        ("cgadsub".into(), raw(0x31).to_string()),
        (
            "coldata".into(),
            list(&[
                i64::from(p.coldata[0]),
                i64::from(p.coldata[1]),
                i64::from(p.coldata[2]),
            ]),
        ),
        ("setini".into(), raw(0x33).to_string()),
        ("vmain".into(), i64::from(p.vmain).to_string()),
        ("vram_addr".into(), i64::from(p.vaddr).to_string()),
        ("oam_addr".into(), i64::from(p.oam_addr).to_string()),
    ];
    let n = fields.len();
    for (i, (k, v)) in fields.iter().enumerate() {
        let _ = writeln!(
            s,
            "    \"{}\": {}{}",
            k,
            v,
            if i + 1 < n { "," } else { "" }
        );
    }
    s.push_str("  },\n");
    s.push_str("  \"raw\": {");
    for r in 0..NREGS {
        let _ = write!(
            s,
            "{}\"21{:02x}\": {}",
            if r == 0 { "" } else { ", " },
            r,
            p.raw[r]
        );
    }
    s.push_str("},\n");
    s.push_str("  \"hdma\": {");
    let mut first = true;
    for r in 0..NREGS {
        if b.hdma_touched & (1 << r) == 0 {
            continue;
        }
        let vals: Vec<i64> = b.line_regs.iter().map(|l| i64::from(l[r])).collect();
        let _ = write!(
            s,
            "{}\n    \"21{:02x}\": {}",
            if first { "" } else { "," },
            r,
            list(&vals)
        );
        first = false;
    }
    s.push_str(if first { "},\n" } else { "\n  },\n" });
    let _ = writeln!(
        s,
        "  \"hdmaen\": {}, \"nmitimen\": {}",
        b.hdmaen, b.nmitimen
    );
    s.push_str("}\n");
    s
}

/// The PPU memory as it stands when the next frame starts to be drawn,
/// i.e. after the NMI that follows a vblank snapshot has made its uploads.
/// That, with the WRAM of the vblank snapshot, is what the screen shows.
pub fn write_post(cpu: &Cpu, dir: &Path) -> io::Result<()> {
    let p = &cpu.bus.ppu;
    fs::write(dir.join("vram_post.bin"), &p.vram)?;
    fs::write(dir.join("cgram_post.bin"), p.cgram)?;
    fs::write(dir.join("oam_post.bin"), p.oam)?;
    Ok(())
}

pub fn write(cpu: &Cpu, dir: &Path, reason: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let p = &cpu.bus.ppu;
    fs::write(dir.join("vram.bin"), &p.vram)?;
    fs::write(dir.join("cgram.bin"), p.cgram)?;
    fs::write(dir.join("oam.bin"), p.oam)?;
    fs::write(dir.join("wram.bin"), &cpu.bus.wram)?;
    fs::write(dir.join("regs.json"), regs_json(cpu, reason))?;
    Ok(())
}
