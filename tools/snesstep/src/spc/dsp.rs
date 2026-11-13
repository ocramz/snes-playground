//! The S-DSP: eight BRR voices, envelopes, noise, pitch modulation and echo.
//!
//! One call to `run_sample` produces one 32 kHz stereo sample. The arithmetic
//! (15-bit BRR samples, the 4-point Gaussian kernel, the 11-bit envelope,
//! where 16-bit sums wrap and where they saturate) follows fullsnes "SNES APU
//! DSP ..." and the per-step ordering follows the hardware's T0-T31 schedule
//! as far as a per-sample model can: voices in order 0-7, then echo, then the
//! global latches that the real chip reads late in the sample (KON/KOFF on
//! every other sample, NON/EON/DIR/PMON, the rate counter and the noise
//! generator).
//!
//! What is deliberately not modelled: the position of each register read
//! inside the 32-cycle sample, and the final output inversion done by the
//! console's post-amplifier (fullsnes "Output Mixer": `sum XOR FFFFh`). The
//! output here has the DSP's own polarity, as other SPC players do.

use super::tables::{COUNTER_RANGE, GAUSS, RATE_OFFSET, RATE_PERIOD};

// Per-voice registers, low nibble.
const V_VOLL: usize = 0x0;
const V_VOLR: usize = 0x1;
const V_PITCHL: usize = 0x2;
const V_PITCHH: usize = 0x3;
const V_SRCN: usize = 0x4;
const V_ADSR1: usize = 0x5;
const V_ADSR2: usize = 0x6;
const V_GAIN: usize = 0x7;
const V_ENVX: usize = 0x8;
const V_OUTX: usize = 0x9;

// Global registers.
const R_MVOLL: usize = 0x0C;
const R_MVOLR: usize = 0x1C;
const R_EVOLL: usize = 0x2C;
const R_EVOLR: usize = 0x3C;
const R_KON: usize = 0x4C;
const R_KOFF: usize = 0x5C;
const R_FLG: usize = 0x6C;
const R_ENDX: usize = 0x7C;
const R_EFB: usize = 0x0D;
const R_PMON: usize = 0x2D;
const R_NON: usize = 0x3D;
const R_EON: usize = 0x4D;
const R_DIR: usize = 0x5D;
const R_ESA: usize = 0x6D;
const R_EDL: usize = 0x7D;
const R_FIR: usize = 0x0F;

const FLG_RESET: u8 = 0x80;
const FLG_MUTE: u8 = 0x40;
const FLG_ECHO_OFF: u8 = 0x20;

const BRR_BLOCK: u8 = 9;
/// Decoded samples kept per voice. The buffer is stored twice over so the
/// interpolator can read four in a row without wrapping.
const BRR_BUF: usize = 12;
/// Samples between a key-on being seen and the voice producing output.
const KON_DELAY: u8 = 5;

const ENV_MAX: i32 = 0x7FF;
const RELEASE_STEP: i32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvMode {
    Release,
    Attack,
    Decay,
    Sustain,
}

#[derive(Debug, Clone, Copy)]
struct Voice {
    buf: [i32; BRR_BUF * 2],
    buf_pos: usize,
    /// 3.12 fixed-point read position within the four newest samples.
    interp_pos: i32,
    brr_addr: u16,
    brr_offset: u8,
    kon_delay: u8,
    env_mode: EnvMode,
    env: i32,
    /// The envelope before clamping, which the bent-increase GAIN mode tests.
    hidden_env: i32,
}

impl Voice {
    const fn new() -> Self {
        Self {
            buf: [0; BRR_BUF * 2],
            buf_pos: 0,
            interp_pos: 0,
            brr_addr: 0,
            brr_offset: 1,
            kon_delay: 0,
            env_mode: EnvMode::Release,
            env: 0,
            hidden_env: 0,
        }
    }
}

/// A key-on as the DSP acted on it, for `--log-kon`.
#[derive(Debug, Clone, Copy)]
pub struct KonEvent {
    /// Output sample during which the voice loaded its BRR start address.
    pub sample: u64,
    pub voice: u8,
    pub srcn: u8,
    pub pitch: u16,
    pub brr_addr: u16,
    pub adsr1: u8,
    pub adsr2: u8,
    pub gain: u8,
    pub voll: i8,
    pub volr: i8,
}

pub struct Dsp {
    regs: [u8; 128],
    voices: [Voice; 8],

    /// KON as last written, cleared once the DSP has acted on it.
    new_kon: u8,
    /// The key-on bits latched for the current pair of samples.
    kon: u8,
    koff: u8,
    every_other_sample: bool,

    // Registers the hardware latches late in the previous sample.
    t_pmon: u8,
    t_non: u8,
    t_eon: u8,
    t_dir: u8,
    t_esa: u8,

    counter: u32,
    noise: i32,

    echo_offset: u32,
    echo_length: u32,
    echo_hist: [[i32; 2]; 8],
    echo_hist_pos: usize,

    /// Voices left out of the mix (and of the echo input).
    pub mute_mask: u8,
    /// Each voice's contribution to the dry mix for the last sample, after
    /// VxVOL and MVOL but without echo. Filled only when `capture_voices`.
    pub voice_out: [[i16; 2]; 8],
    pub capture_voices: bool,
    pub log_kon: bool,
    pub kon_events: Vec<KonEvent>,
    /// Key-ons acted on, per voice.
    pub kon_count: [u32; 8],
}

#[inline]
fn clamp16(value: i32) -> i32 {
    value.clamp(-0x8000, 0x7FFF)
}

#[inline]
fn wrap16(value: i32) -> i32 {
    i32::from(value as i16)
}

impl Dsp {
    /// A DSP in its reset state: muted, echo writes off, every voice released.
    pub fn new() -> Self {
        let mut regs = [0u8; 128];
        regs[R_FLG] = FLG_RESET | FLG_MUTE | FLG_ECHO_OFF;
        Self {
            regs,
            voices: [Voice::new(); 8],
            new_kon: 0,
            kon: 0,
            koff: 0,
            every_other_sample: true,
            t_pmon: 0,
            t_non: 0,
            t_eon: 0,
            t_dir: 0,
            t_esa: 0,
            counter: 0,
            noise: 0x4000,
            echo_offset: 0,
            echo_length: 0,
            echo_hist: [[0; 2]; 8],
            echo_hist_pos: 0,
            mute_mask: 0,
            voice_out: [[0; 2]; 8],
            capture_voices: false,
            log_kon: false,
            kon_events: Vec::new(),
            kon_count: [0; 8],
        }
    }

    /// Adopt a register snapshot, as from a `.spc` file. Voice state is not
    /// part of the snapshot: every voice starts released, and any bit set in
    /// KON keys its voice on, which is how snapshot players start a tune that
    /// was captured mid-note.
    pub fn load(&mut self, regs: &[u8; 128]) {
        let (mute_mask, capture, log) = (self.mute_mask, self.capture_voices, self.log_kon);
        *self = Self::new();
        self.mute_mask = mute_mask;
        self.capture_voices = capture;
        self.log_kon = log;
        self.regs = *regs;
        self.new_kon = regs[R_KON];
        self.t_dir = regs[R_DIR];
        self.t_esa = regs[R_ESA];
        self.t_pmon = regs[R_PMON] & 0xFE;
        self.t_non = regs[R_NON];
        self.t_eon = regs[R_EON];
    }

    #[inline]
    pub fn read(&self, addr: u8) -> u8 {
        self.regs[usize::from(addr & 0x7F)]
    }

    pub fn write(&mut self, addr: u8, value: u8) {
        let index = usize::from(addr & 0x7F);
        self.regs[index] = value;
        match index {
            R_KON => self.new_kon = value,
            // Any write clears every end flag, whatever the value.
            R_ENDX => self.regs[R_ENDX] = 0,
            _ => {}
        }
    }

    /// True when no voice is sounding or about to: every envelope is at zero
    /// and no key-on is pending.
    pub fn voices_idle(&self) -> bool {
        self.new_kon == 0
            && self.kon == 0
            && self.voices.iter().all(|v| v.env == 0 && v.kon_delay == 0)
    }

    /// Echo buffer length in samples as currently latched (EDL * 512).
    pub fn echo_samples(&self) -> u32 {
        self.echo_length / 4
    }

    /// True if the echo path can reach the output at all.
    pub fn echo_audible(&self) -> bool {
        self.regs[R_EVOLL] != 0 || self.regs[R_EVOLR] != 0
    }

    #[inline]
    fn rate_fires(&self, rate: usize) -> bool {
        let period = u32::from(RATE_PERIOD[rate]);
        period != 0 && (self.counter + u32::from(RATE_OFFSET[rate])).is_multiple_of(period)
    }

    fn interpolate(voice: &Voice) -> i32 {
        let fraction = ((voice.interp_pos >> 4) & 0xFF) as usize;
        let base = (voice.interp_pos >> 12) as usize + voice.buf_pos;
        let s = &voice.buf[base..base + 4];
        // The first three taps are summed without overflow handling and wrap
        // at 16 bits; only the last addition saturates.
        let mut out = (i32::from(GAUSS[255 - fraction]) * s[0]) >> 11;
        out += (i32::from(GAUSS[511 - fraction]) * s[1]) >> 11;
        out += (i32::from(GAUSS[256 + fraction]) * s[2]) >> 11;
        out = wrap16(out);
        out += (i32::from(GAUSS[fraction]) * s[3]) >> 11;
        clamp16(out) & !1
    }

    /// Decode the next four BRR samples of a voice into its ring buffer.
    /// Samples are kept doubled (15-bit value in bits 15-1), which is the
    /// form the interpolator wants.
    fn decode_brr(voice: &mut Voice, header: u8, first: u8, second: u8) {
        let mut nybbles = (i32::from(first) << 8) | i32::from(second);
        let shift = header >> 4;
        let filter = header & 0x0C;
        let start = voice.buf_pos;
        voice.buf_pos += 4;
        if voice.buf_pos >= BRR_BUF {
            voice.buf_pos = 0;
        }
        for pos in start..start + 4 {
            let mut s = i32::from(nybbles as i16) >> 12;
            nybbles <<= 4;
            s = (s << shift) >> 1;
            if shift >= 0x0D {
                // Reserved shifts: only the sign survives.
                s = (s >> 25) << 11;
            }
            let p1 = voice.buf[pos + BRR_BUF - 1];
            let p2 = voice.buf[pos + BRR_BUF - 2] >> 1;
            match filter {
                0x00 => {}
                // old * 15/16
                0x04 => {
                    s += p1 >> 1;
                    s += (-p1) >> 5;
                }
                // old * 61/32 - older * 15/16
                0x08 => {
                    s += p1;
                    s -= p2;
                    s += p2 >> 4;
                    s += (p1 * -3) >> 6;
                }
                // old * 115/64 - older * 13/16
                _ => {
                    s += p1;
                    s -= p2;
                    s += (p1 * -13) >> 7;
                    s += (p2 * 3) >> 4;
                }
            }
            // Saturate to 16 bits, then keep 15: the doubling wraps.
            let s = wrap16(clamp16(s) * 2);
            voice.buf[pos] = s;
            voice.buf[pos + BRR_BUF] = s;
        }
    }

    fn run_envelope(&mut self, index: usize, adsr1: u8) {
        let base = index << 4;
        let voice = &self.voices[index];
        let mut env = voice.env;
        let mode = voice.env_mode;

        if mode == EnvMode::Release {
            env = (env - RELEASE_STEP).max(0);
            self.voices[index].env = env;
            return;
        }

        let rate: usize;
        let mut env_data = self.regs[base + V_ADSR2];
        if adsr1 & 0x80 != 0 {
            if mode == EnvMode::Attack {
                rate = usize::from(adsr1 & 0x0F) * 2 + 1;
                env += if rate < 31 { 0x20 } else { 0x400 };
            } else {
                env -= 1;
                env -= env >> 8;
                rate = if mode == EnvMode::Decay {
                    usize::from((adsr1 >> 3) & 0x0E) + 0x10
                } else {
                    usize::from(env_data & 0x1F)
                };
            }
        } else {
            env_data = self.regs[base + V_GAIN];
            let gain_mode = env_data >> 5;
            if gain_mode < 4 {
                // Direct: the level is set outright.
                env = i32::from(env_data) * 0x10;
                rate = 31;
            } else {
                rate = usize::from(env_data & 0x1F);
                match gain_mode {
                    4 => env -= 0x20,
                    5 => {
                        env -= 1;
                        env -= env >> 8;
                    }
                    6 => env += 0x20,
                    _ => {
                        env += if voice.hidden_env as u32 >= 0x600 {
                            0x08
                        } else {
                            0x20
                        }
                    }
                }
            }
        }

        let mut next_mode = mode;
        // In GAIN mode this compares against GAIN's top bits, not ADSR2's;
        // the hardware does the same (fullsnes, "Gain Notes").
        if (env >> 8) == i32::from(env_data >> 5) && mode == EnvMode::Decay {
            next_mode = EnvMode::Sustain;
        }
        let hidden = env;
        if !(0..=ENV_MAX).contains(&env) {
            env = if env < 0 { 0 } else { ENV_MAX };
            if mode == EnvMode::Attack {
                next_mode = EnvMode::Decay;
            }
        }
        let fires = self.rate_fires(rate);
        let voice = &mut self.voices[index];
        voice.env_mode = next_mode;
        voice.hidden_env = hidden;
        if fires {
            voice.env = env;
        }
    }

    /// Produce one stereo sample. `ram` is the APU's memory: sample data and
    /// the directory are read from it and the echo buffer lives in it.
    pub fn run_sample(&mut self, ram: &mut [u8; 0x10000], sample_index: u64) -> (i16, i16) {
        let flg = self.regs[R_FLG];
        let mvol = [
            i32::from(self.regs[R_MVOLL] as i8),
            i32::from(self.regs[R_MVOLR] as i8),
        ];
        let mut main = [0i32; 2];
        let mut echo = [0i32; 2];
        let mut prev_output = 0i32;

        for index in 0..8 {
            let base = index << 4;
            let vbit = 1u8 << index;

            let srcn = self.regs[base + V_SRCN];
            let adsr1 = self.regs[base + V_ADSR1];
            let mut pitch = i32::from(self.regs[base + V_PITCHL])
                | (i32::from(self.regs[base + V_PITCHH] & 0x3F) << 8);

            // Directory entry: the start address while keying on, else the
            // loop address.
            let dir_addr = (usize::from(self.t_dir) << 8) + (usize::from(srcn) << 2);
            let entry = if self.voices[index].kon_delay != 0 {
                dir_addr
            } else {
                dir_addr + 2
            };
            let next_addr = u16::from_le_bytes([ram[entry & 0xFFFF], ram[(entry + 1) & 0xFFFF]]);

            let brr_addr = self.voices[index].brr_addr;
            let brr_offset = u16::from(self.voices[index].brr_offset);
            let mut header = ram[usize::from(brr_addr)];
            let brr_first = ram[usize::from(brr_addr.wrapping_add(brr_offset))];
            let brr_second = ram[usize::from(brr_addr.wrapping_add(brr_offset + 1))];

            if self.t_pmon & vbit != 0 {
                pitch += ((prev_output >> 5) * pitch) >> 10;
            }

            if self.voices[index].kon_delay != 0 {
                if self.voices[index].kon_delay == KON_DELAY {
                    let voice = &mut self.voices[index];
                    voice.brr_addr = next_addr;
                    voice.brr_offset = 1;
                    voice.buf_pos = 0;
                    // Whatever block the voice was on no longer matters.
                    header = 0;
                    self.kon_count[index] += 1;
                    if self.log_kon {
                        self.kon_events.push(KonEvent {
                            sample: sample_index,
                            voice: index as u8,
                            srcn,
                            pitch: pitch as u16,
                            brr_addr: next_addr,
                            adsr1,
                            adsr2: self.regs[base + V_ADSR2],
                            gain: self.regs[base + V_GAIN],
                            voll: self.regs[base + V_VOLL] as i8,
                            volr: self.regs[base + V_VOLR] as i8,
                        });
                    }
                }
                let voice = &mut self.voices[index];
                // No envelope and no pitch while the voice starts up; BRR
                // decoding is held off except on the last three samples,
                // which prime the interpolator with twelve samples.
                voice.env = 0;
                voice.hidden_env = 0;
                voice.kon_delay -= 1;
                voice.interp_pos = if voice.kon_delay & 3 != 0 { 0x4000 } else { 0 };
                pitch = 0;
            }

            let mut output = if self.t_non & vbit != 0 {
                wrap16(self.noise * 2)
            } else {
                Self::interpolate(&self.voices[index])
            };
            let env = self.voices[index].env;
            output = ((output * env) >> 11) & !1;
            let envx = (env >> 4) as u8;

            // Soft reset, or a block marked "end" without "loop": silence now.
            if flg & FLG_RESET != 0 || header & 3 == 1 {
                let voice = &mut self.voices[index];
                voice.env_mode = EnvMode::Release;
                voice.env = 0;
            }

            if self.every_other_sample {
                if self.koff & vbit != 0 {
                    self.voices[index].env_mode = EnvMode::Release;
                }
                if self.kon & vbit != 0 {
                    let voice = &mut self.voices[index];
                    voice.kon_delay = KON_DELAY;
                    voice.env_mode = EnvMode::Attack;
                }
            }

            if self.voices[index].kon_delay == 0 {
                self.run_envelope(index, adsr1);
            }

            let mut looped = false;
            {
                let voice = &mut self.voices[index];
                if voice.interp_pos >= 0x4000 {
                    Self::decode_brr(voice, header, brr_first, brr_second);
                    voice.brr_offset += 2;
                    if voice.brr_offset >= BRR_BLOCK {
                        voice.brr_addr = voice.brr_addr.wrapping_add(u16::from(BRR_BLOCK));
                        if header & 1 != 0 {
                            voice.brr_addr = next_addr;
                            looped = true;
                        }
                        voice.brr_offset = 1;
                    }
                }
                voice.interp_pos = ((voice.interp_pos & 0x3FFF) + pitch).min(0x7FFF);
            }

            let muted = self.mute_mask & vbit != 0;
            for ch in 0..2 {
                let vol = i32::from(self.regs[base + V_VOLL + ch] as i8);
                let amp = (output * vol) >> 7;
                if self.capture_voices {
                    self.voice_out[index][ch] = clamp16((amp * mvol[ch]) >> 7) as i16;
                }
                if muted {
                    continue;
                }
                main[ch] = clamp16(main[ch] + amp);
                if self.t_eon & vbit != 0 {
                    echo[ch] = clamp16(echo[ch] + amp);
                }
            }

            let mut endx = self.regs[R_ENDX];
            if looped {
                endx |= vbit;
            }
            if self.voices[index].kon_delay == KON_DELAY {
                endx &= !vbit;
            }
            self.regs[R_ENDX] = endx;
            self.regs[base + V_OUTX] = (output >> 8) as u8;
            self.regs[base + V_ENVX] = envx;
            prev_output = output;
        }

        // Echo: take the oldest entry out of the ring buffer in RAM, run it
        // through the 8-tap FIR, mix, and write the new entry back.
        let echo_ptr = ((usize::from(self.t_esa) << 8) + self.echo_offset as usize) & 0xFFFF;
        self.echo_hist_pos = (self.echo_hist_pos + 1) & 7;
        let newest = self.echo_hist_pos;
        for ch in 0..2 {
            let at = echo_ptr + ch * 2;
            let raw = i16::from_le_bytes([ram[at & 0xFFFF], ram[(at + 1) & 0xFFFF]]);
            self.echo_hist[newest][ch] = i32::from(raw) >> 1;
        }
        let mut echo_in = [0i32; 2];
        for (ch, slot) in echo_in.iter_mut().enumerate() {
            // FIR0 weights the oldest of the eight samples, FIR7 the newest.
            let mut sum = 0i32;
            for tap in 0..7 {
                let coeff = i32::from(self.regs[R_FIR + (tap << 4)] as i8);
                sum += (self.echo_hist[(newest + tap + 1) & 7][ch] * coeff) >> 6;
            }
            sum = wrap16(sum);
            let coeff = i32::from(self.regs[R_FIR + 0x70] as i8);
            sum += wrap16((self.echo_hist[newest][ch] * coeff) >> 6);
            *slot = clamp16(sum) & !1;
        }

        let evol = [
            i32::from(self.regs[R_EVOLL] as i8),
            i32::from(self.regs[R_EVOLR] as i8),
        ];
        let efb = i32::from(self.regs[R_EFB] as i8);
        let mut out = [0i32; 2];
        for ch in 0..2 {
            out[ch] =
                clamp16(wrap16((main[ch] * mvol[ch]) >> 7) + wrap16((echo_in[ch] * evol[ch]) >> 7));
            let feedback = clamp16(echo[ch] + wrap16((echo_in[ch] * efb) >> 7)) & !1;
            if flg & FLG_ECHO_OFF == 0 {
                let at = echo_ptr + ch * 2;
                let [lo, hi] = (feedback as i16).to_le_bytes();
                ram[at & 0xFFFF] = lo;
                ram[(at + 1) & 0xFFFF] = hi;
            }
        }
        if self.echo_offset == 0 {
            self.echo_length = u32::from(self.regs[R_EDL] & 0x0F) * 0x800;
        }
        self.echo_offset += 4;
        if self.echo_offset >= self.echo_length {
            self.echo_offset = 0;
        }

        // Latches for the next sample.
        self.t_esa = self.regs[R_ESA];
        self.t_pmon = self.regs[R_PMON] & 0xFE;
        self.t_non = self.regs[R_NON];
        self.t_eon = self.regs[R_EON];
        self.t_dir = self.regs[R_DIR];
        self.every_other_sample = !self.every_other_sample;
        if self.every_other_sample {
            // KON and KOFF are polled at 16 kHz. A key-on that has been acted
            // on is dropped unless the program wrote the bit again.
            self.new_kon &= !self.kon;
            self.kon = self.new_kon;
            self.koff = self.regs[R_KOFF];
        }
        self.counter = if self.counter == 0 {
            COUNTER_RANGE - 1
        } else {
            self.counter - 1
        };
        if self.rate_fires(usize::from(self.regs[R_FLG] & 0x1F)) {
            let feedback = (self.noise << 13) ^ (self.noise << 14);
            self.noise = (feedback & 0x4000) ^ (self.noise >> 1);
        }

        if flg & FLG_MUTE != 0 {
            return (0, 0);
        }
        (out[0] as i16, out[1] as i16)
    }

    /// Envelope level (0-2047) of one voice.
    pub fn envelope(&self, voice: usize) -> i32 {
        self.voices[voice].env
    }

    /// Current 15-bit level of the noise generator.
    pub fn noise_level(&self) -> i32 {
        self.noise
    }
}

impl Default for Dsp {
    fn default() -> Self {
        Self::new()
    }
}
