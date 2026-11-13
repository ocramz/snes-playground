//! Minimal RIFF/WAVE writer: 16-bit PCM, interleaved.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

/// DSP output rate in Hz.
pub const SAMPLE_RATE: u32 = 32_000;

/// Write interleaved 16-bit samples as a WAV file.
///
/// # Errors
///
/// Any I/O error creating or writing the file, or `InvalidInput` if the data
/// would overflow the 32-bit RIFF size fields.
pub fn write_wav(path: &Path, channels: u16, samples: &[i16]) -> io::Result<()> {
    let data_len = u32::try_from(samples.len() * 2)
        .ok()
        .filter(|&n| n <= u32::MAX - 36)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "too long for a WAV file"))?;
    let block_align = channels * 2;
    let mut out = BufWriter::new(File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_len).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&1u16.to_le_bytes())?; // PCM
    out.write_all(&channels.to_le_bytes())?;
    out.write_all(&SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(SAMPLE_RATE * u32::from(block_align)).to_le_bytes())?;
    out.write_all(&block_align.to_le_bytes())?;
    out.write_all(&16u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data_len.to_le_bytes())?;
    for sample in samples {
        out.write_all(&sample.to_le_bytes())?;
    }
    out.flush()
}
