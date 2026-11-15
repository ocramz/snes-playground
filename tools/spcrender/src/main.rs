//! spcrender: play a `.spc` file through an SPC700 + S-DSP model and write
//! the result as a 32 kHz stereo 16-bit WAV.
//!
//! It is a general `.spc` player, not a Kirby-specific one: it knows nothing about the driver and
//! simply runs whatever program the image contains.
//!
//! A one-line JSON summary goes to stdout so `tools/render_audio.py` can
//! collect durations, levels and the voices used without re-reading the WAV.

mod apu;
mod cpu;
mod dsp;
mod selftest;
mod tables;
mod wav;

use std::fmt::{self, Write as _};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use apu::{Apu, SpcError};
use wav::SAMPLE_RATE;

const USAGE: &str = "\
usage: spcrender INPUT.spc [-o OUT.wav] [options]
       spcrender --selftest

  -o, --output FILE         write a 32 kHz stereo 16-bit WAV
  --seconds N               play time before the fade (may be fractional).
                            Default: the file's ID666 length tag, else 180
  --fade MS                 linear fade-out appended after --seconds.
                            Default: the file's ID666 fade tag, else 0
  --until-silent [TAIL_MS]  stop once every voice's envelope is 0, no key-on
                            is pending and the output has been exactly zero
                            for TAIL_MS (default 250; never less than the
                            echo delay while echo is audible). The file ends
                            TAIL_MS after the last non-zero sample. Nothing
                            stops before the first key-on. --seconds becomes
                            an upper bound (default 600) and the fade applies
                            only if that bound is reached
  --min-seconds N           with --until-silent: do not stop before N, however
                            quiet it is. A sequence can rest for longer than
                            the tail and then play again
  --busy ADDR[,ADDR...]     with --until-silent: do not stop while any of
                            these RAM bytes is non-zero. Point it at whatever
                            the program keeps non-zero while a sequence is
                            still running
  --trim-leading            drop the digital silence before the first
                            non-zero sample
  --stems                   with -o, also write OUT_v0.wav .. OUT_v7.wav: each
                            voice after its own volume and the master volume,
                            without echo
  --log-kon FILE            TSV of every key-on the DSP acted on: sample,
                            seconds, voice, SRCN, pitch, BRR start address,
                            ADSR1, ADSR2, GAIN, VOL L, VOL R
  --mute-voices MASK        leave these voices out of the mix; bit n is
                            voice n (decimal or 0x hex)
  --solo-source ADDR[,ADDR...]
                            mix only the voices whose last key-on loaded one
                            of these BRR start addresses (the sample
                            directory's start entries); the rest are left out
                            as by --mute-voices
  --no-echo                 leave the echo return out of the output. The echo
                            buffer is still written, so the run is unchanged
  --watch ADDR[,ADDR...]    RAM addresses whose writes go to --log-watch
  --log-watch FILE          TSV: sample, seconds, address, value, PC
  --trace N                 print the first N instructions to stderr
  --selftest                run the built-in checks and exit
  -h, --help                this text
";

const DEFAULT_SECONDS: f64 = 180.0;
const DEFAULT_SILENT_CAP_SECONDS: f64 = 600.0;
const DEFAULT_TAIL_MS: u64 = 250;

#[derive(Debug)]
enum Error {
    Usage(String),
    Io { path: PathBuf, source: io::Error },
    Spc { path: PathBuf, source: SpcError },
    SelfTest(usize),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Usage(message) => write!(f, "{message}\n\n{USAGE}"),
            Error::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Error::Spc { path, source } => write!(f, "{}: {source}", path.display()),
            Error::SelfTest(failed) => write!(f, "{failed} self-test check(s) failed"),
        }
    }
}

#[derive(Debug, Default)]
struct Options {
    input: Option<PathBuf>,
    output: Option<PathBuf>,
    seconds: Option<f64>,
    fade_ms: Option<u64>,
    until_silent: Option<u64>,
    min_seconds: f64,
    trim_leading: bool,
    stems: bool,
    log_kon: Option<PathBuf>,
    mute_voices: u8,
    solo_sources: Vec<u16>,
    no_echo: bool,
    watch: Vec<u16>,
    busy: Vec<u16>,
    log_watch: Option<PathBuf>,
    trace: u64,
    selftest: bool,
    help: bool,
}

fn parse_int(text: &str) -> Option<u64> {
    let text = text.trim();
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok();
    }
    if let Some(hex) = text.strip_prefix('$') {
        return u64::from_str_radix(hex, 16).ok();
    }
    text.parse().ok()
}

fn parse_args(args: &[String]) -> Result<Options, Error> {
    let mut opts = Options::default();
    let mut i = 0;
    let value = |i: &mut usize, flag: &str| -> Result<String, Error> {
        *i += 1;
        args.get(*i)
            .cloned()
            .ok_or_else(|| Error::Usage(format!("{flag} needs a value")))
    };
    let bad = |flag: &str, text: &str| Error::Usage(format!("{flag}: cannot parse '{text}'"));
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-h" | "--help" => opts.help = true,
            "--selftest" => opts.selftest = true,
            "--stems" => opts.stems = true,
            "--trim-leading" => opts.trim_leading = true,
            "--no-echo" => opts.no_echo = true,
            "-o" | "--output" => opts.output = Some(PathBuf::from(value(&mut i, arg)?)),
            "--log-kon" => opts.log_kon = Some(PathBuf::from(value(&mut i, arg)?)),
            "--log-watch" => opts.log_watch = Some(PathBuf::from(value(&mut i, arg)?)),
            "--seconds" => {
                let text = value(&mut i, arg)?;
                let seconds: f64 = text.parse().map_err(|_| bad(arg, &text))?;
                if !seconds.is_finite() || seconds < 0.0 {
                    return Err(bad(arg, &text));
                }
                opts.seconds = Some(seconds);
            }
            "--min-seconds" => {
                let text = value(&mut i, arg)?;
                let seconds: f64 = text.parse().map_err(|_| bad(arg, &text))?;
                if !seconds.is_finite() || seconds < 0.0 {
                    return Err(bad(arg, &text));
                }
                opts.min_seconds = seconds;
            }
            "--fade" => {
                let text = value(&mut i, arg)?;
                opts.fade_ms = Some(parse_int(&text).ok_or_else(|| bad(arg, &text))?);
            }
            "--until-silent" => {
                // The tail is optional: take the next argument only if it is
                // a bare number.
                let tail = args.get(i + 1).and_then(|next| next.parse::<u64>().ok());
                if tail.is_some() {
                    i += 1;
                }
                opts.until_silent = Some(tail.unwrap_or(DEFAULT_TAIL_MS));
            }
            "--mute-voices" => {
                let text = value(&mut i, arg)?;
                let mask = parse_int(&text)
                    .filter(|&m| m <= 0xFF)
                    .ok_or_else(|| bad(arg, &text))?;
                opts.mute_voices = mask as u8;
            }
            "--watch" | "--busy" | "--solo-source" => {
                let text = value(&mut i, arg)?;
                for part in text.split(',') {
                    let addr = parse_int(part)
                        .filter(|&a| a <= 0xFFFF)
                        .ok_or_else(|| bad(arg, part))?;
                    match arg {
                        "--watch" => opts.watch.push(addr as u16),
                        "--busy" => opts.busy.push(addr as u16),
                        _ => opts.solo_sources.push(addr as u16),
                    }
                }
            }
            "--trace" => {
                let text = value(&mut i, arg)?;
                opts.trace = parse_int(&text).ok_or_else(|| bad(arg, &text))?;
            }
            _ if arg.starts_with('-') && arg.len() > 1 => {
                return Err(Error::Usage(format!("unknown option {arg}")));
            }
            _ => {
                if opts.input.is_some() {
                    return Err(Error::Usage(format!("unexpected extra argument '{arg}'")));
                }
                opts.input = Some(PathBuf::from(arg));
            }
        }
        i += 1;
    }
    Ok(opts)
}

fn seconds_to_samples(seconds: f64) -> u64 {
    (seconds * f64::from(SAMPLE_RATE)).round() as u64
}

fn samples_to_seconds(samples: u64) -> f64 {
    samples as f64 / f64::from(SAMPLE_RATE)
}

fn write_file(path: &Path, contents: &str) -> Result<(), Error> {
    fs::write(path, contents).map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn stem_path(output: &Path, voice: usize) -> PathBuf {
    let stem = output
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    output.with_file_name(format!("{stem}_v{voice}.wav"))
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Why rendering stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    /// Reached the requested length.
    Length,
    /// `--until-silent` found silence.
    Silent,
    /// `--until-silent` hit its upper bound while still sounding.
    Cap,
}

impl Stop {
    fn as_str(self) -> &'static str {
        match self {
            Stop::Length => "length",
            Stop::Silent => "silent",
            Stop::Cap => "cap",
        }
    }
}

fn render(opts: &Options, input: &Path) -> Result<(), Error> {
    let data = fs::read(input).map_err(|source| Error::Io {
        path: input.to_path_buf(),
        source,
    })?;
    let mut apu = Apu::from_spc(&data).map_err(|source| Error::Spc {
        path: input.to_path_buf(),
        source,
    })?;
    apu.dsp.mute_mask = opts.mute_voices;
    apu.dsp.solo_sources = opts.solo_sources.clone();
    apu.dsp.no_echo = opts.no_echo;
    apu.dsp.log_kon = opts.log_kon.is_some();
    apu.dsp.capture_voices = opts.stems && opts.output.is_some();
    apu.trace_left = opts.trace;
    for &addr in &opts.watch {
        apu.watch(addr);
    }

    let tag = Apu::id666_length(&data);
    let (seconds, length_source) = match (opts.seconds, opts.until_silent, tag) {
        (Some(s), _, _) => (s, "argument"),
        (None, Some(_), _) => (DEFAULT_SILENT_CAP_SECONDS, "default cap"),
        (None, None, Some(t)) => (f64::from(t.seconds), "id666"),
        (None, None, None) => (DEFAULT_SECONDS, "default"),
    };
    let fade_ms = match (opts.fade_ms, opts.seconds, opts.until_silent, tag) {
        (Some(ms), _, _, _) => ms,
        (None, None, None, Some(t)) => u64::from(t.fade_ms),
        _ => 0,
    };
    let body = seconds_to_samples(seconds);
    let fade = fade_ms * u64::from(SAMPLE_RATE) / 1000;
    let limit = body + fade;
    let tail = opts
        .until_silent
        .map(|ms| ms * u64::from(SAMPLE_RATE) / 1000);
    let earliest_stop = seconds_to_samples(opts.min_seconds);

    let mut pcm: Vec<i16> = Vec::new();
    let mut stems: Vec<Vec<i16>> = if apu.dsp.capture_voices {
        vec![Vec::new(); 8]
    } else {
        Vec::new()
    };
    let mut first_loud: Option<u64> = None;
    let mut last_loud: Option<u64> = None;
    let mut silent_run = 0u64;
    let mut busy_end: Option<u64> = None;
    let mut stop = Stop::Length;
    let started = Instant::now();

    let mut index = 0u64;
    while index < limit {
        let (l, r) = apu.run_sample();
        pcm.push(l);
        pcm.push(r);
        for (voice, stem) in stems.iter_mut().enumerate() {
            stem.extend_from_slice(&apu.dsp.voice_out[voice]);
        }
        let loud = l != 0 || r != 0;
        if loud {
            first_loud.get_or_insert(index);
            last_loud = Some(index);
        }
        let busy = opts
            .busy
            .iter()
            .any(|&addr| apu.ram[usize::from(addr)] != 0);
        if busy {
            busy_end = Some(index + 1);
        }
        if loud || busy || !apu.dsp.voices_idle() {
            silent_run = 0;
        } else {
            silent_run += 1;
        }
        index += 1;
        if let Some(tail) = tail {
            let echo = if apu.dsp.echo_audible() {
                u64::from(apu.dsp.echo_samples()) + 32
            } else {
                0
            };
            let keyed = apu.dsp.kon_count.iter().any(|&n| n > 0);
            if keyed && index >= earliest_stop && silent_run >= tail.max(echo) {
                stop = Stop::Silent;
                break;
            }
        }
    }
    if tail.is_some() && stop != Stop::Silent {
        stop = Stop::Cap;
    }
    let rendered = index;
    let elapsed = started.elapsed().as_secs_f64();

    // Decide which part of what was rendered is kept.
    let mut end = rendered;
    if let (Stop::Silent, Some(tail)) = (stop, tail) {
        end = last_loud.map_or(rendered, |last| (last + 1 + tail).min(rendered));
    }
    let begin = if opts.trim_leading {
        first_loud.unwrap_or(0).min(end)
    } else {
        0
    };

    // The fade belongs to a fixed-length render, or to a capped one.
    if fade > 0 && stop != Stop::Silent {
        let apply = |buffer: &mut [i16]| {
            for i in body..rendered.min(limit) {
                let gain = 1.0 - (i - body) as f64 / fade as f64;
                for ch in 0..2 {
                    let at = (i * 2) as usize + ch;
                    buffer[at] = (f64::from(buffer[at]) * gain).round() as i16;
                }
            }
        };
        apply(&mut pcm);
        for stem in &mut stems {
            apply(stem);
        }
    }

    let window = (begin * 2) as usize..(end * 2) as usize;
    let kept = &pcm[window.clone()];
    let peak = kept.iter().map(|&s| i32::from(s).abs()).max().unwrap_or(0);
    let sum_squares: f64 = kept.iter().map(|&s| f64::from(s) * f64::from(s)).sum();
    let rms = if kept.is_empty() {
        0.0
    } else {
        (sum_squares / kept.len() as f64).sqrt()
    };

    if let Some(output) = &opts.output {
        let io_err = |path: &Path| {
            let path = path.to_path_buf();
            move |source| Error::Io { path, source }
        };
        wav::write_wav(output, 2, kept).map_err(io_err(output))?;
        for (voice, stem) in stems.iter().enumerate() {
            let path = stem_path(output, voice);
            wav::write_wav(&path, 2, &stem[window.clone()]).map_err(io_err(&path))?;
        }
    }

    if let Some(path) = &opts.log_kon {
        let mut text = String::from(
            "sample\tseconds\tvoice\tsrcn\tpitch\tbrr_addr\tadsr1\tadsr2\tgain\tvoll\tvolr\n",
        );
        for e in &apu.dsp.kon_events {
            let _ = writeln!(
                text,
                "{}\t{:.6}\t{}\t{}\t${:04X}\t${:04X}\t${:02X}\t${:02X}\t${:02X}\t{}\t{}",
                e.sample,
                samples_to_seconds(e.sample),
                e.voice,
                e.srcn,
                e.pitch,
                e.brr_addr,
                e.adsr1,
                e.adsr2,
                e.gain,
                e.voll,
                e.volr
            );
        }
        write_file(path, &text)?;
    }
    if let Some(path) = &opts.log_watch {
        let mut text = String::from("sample\tseconds\taddr\tvalue\tpc\n");
        for hit in &apu.watch_hits {
            let _ = writeln!(
                text,
                "{}\t{:.6}\t${:04X}\t${:02X}\t${:04X}",
                hit.sample,
                samples_to_seconds(hit.sample),
                hit.addr,
                hit.value,
                hit.pc
            );
        }
        write_file(path, &text)?;
    }

    let kon_total: u32 = apu.dsp.kon_count.iter().sum();
    let voices_used: Vec<String> = apu
        .dsp
        .kon_count
        .iter()
        .enumerate()
        .filter(|(_, &n)| n > 0)
        .map(|(v, _)| v.to_string())
        .collect();
    let kon_per_voice: Vec<String> = apu.dsp.kon_count.iter().map(u32::to_string).collect();
    let opcodes_used: u32 = apu.opcodes_seen.iter().map(|w| w.count_ones()).sum();
    let opcode_map: String = apu
        .opcodes_seen
        .iter()
        .map(|w| format!("{w:016x}"))
        .collect();
    let audio_seconds = samples_to_seconds(rendered);
    let mut json = String::from("{");
    let _ = write!(json, "\"input\": {}", json_string(&input.to_string_lossy()));
    if let Some(output) = &opts.output {
        let _ = write!(
            json,
            ", \"output\": {}",
            json_string(&output.to_string_lossy())
        );
    }
    let _ = write!(
        json,
        ", \"samples\": {}, \"seconds\": {:.6}, \"rendered_samples\": {}, \
         \"lead_in_samples\": {}, \"first_sound_sample\": {}, \"last_sound_sample\": {}, \
         \"busy_end_sample\": {}, \"stop\": \"{}\", \"length_source\": \"{}\", \"body_seconds\": {:.6}, \"fade_ms\": {}, \
         \"peak\": {}, \"rms\": {:.3}, \"silent\": {}, \
         \"kon_total\": {}, \"kon_per_voice\": [{}], \"voices_used\": [{}], \
         \"saturated_main\": {}, \"saturated_echo\": {}, \"saturated_output\": {}, \
         \"instructions\": {}, \"cycles\": {}, \"opcodes_used\": {}, \"opcode_map\": \"{}\", \
         \"halted\": {}, \"elapsed_seconds\": {:.4}, \"realtime_factor\": {:.1}}}",
        end - begin,
        samples_to_seconds(end - begin),
        rendered,
        begin,
        first_loud.map_or(-1, |s| s as i64),
        last_loud.map_or(-1, |s| s as i64),
        busy_end.map_or(-1, |s| s as i64),
        stop.as_str(),
        length_source,
        seconds,
        fade_ms,
        peak,
        rms,
        peak == 0,
        kon_total,
        kon_per_voice.join(", "),
        voices_used.join(", "),
        apu.dsp.saturated.main,
        apu.dsp.saturated.echo,
        apu.dsp.saturated.output,
        apu.instructions,
        apu.clock,
        opcodes_used,
        opcode_map,
        apu.halted,
        elapsed,
        if elapsed > 0.0 { audio_seconds / elapsed } else { 0.0 },
    );
    println!("{json}");
    Ok(())
}

fn run(args: &[String]) -> Result<(), Error> {
    let opts = parse_args(args)?;
    if opts.help {
        print!("{USAGE}");
        return Ok(());
    }
    if opts.selftest {
        let failed = selftest::run();
        return if failed == 0 {
            Ok(())
        } else {
            Err(Error::SelfTest(failed))
        };
    }
    let Some(input) = opts.input.as_deref() else {
        return Err(Error::Usage("no input file".to_string()));
    };
    if opts.stems && opts.output.is_none() {
        return Err(Error::Usage("--stems needs -o".to_string()));
    }
    if opts.log_watch.is_some() && opts.watch.is_empty() {
        return Err(Error::Usage("--log-watch needs --watch".to_string()));
    }
    render(&opts, input)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("spcrender: {error}");
            match error {
                Error::Usage(_) => ExitCode::from(2),
                _ => ExitCode::FAILURE,
            }
        }
    }
}
