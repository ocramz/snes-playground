//! Minimal binary save-state encoding: fields written in a fixed order,
//! little-endian, no schema. A state file is only valid for the binary (and
//! ROM) that wrote it; the header carries a magic and a version to catch the
//! obvious mismatches.

pub const MAGIC: &[u8; 8] = b"SNSTEP01";

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub fn bool(&mut self, v: bool) {
        self.buf.push(u8::from(v));
    }
    pub fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn bytes(&mut self, v: &[u8]) {
        self.buf.extend_from_slice(v);
    }
}

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        s
    }
    pub fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    pub fn bool(&mut self) -> bool {
        self.u8() != 0
    }
    pub fn u16(&mut self) -> u16 {
        let b = self.take(2);
        u16::from_le_bytes([b[0], b[1]])
    }
    pub fn u32(&mut self) -> u32 {
        let b = self.take(4);
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    }
    pub fn u64(&mut self) -> u64 {
        let mut a = [0u8; 8];
        a.copy_from_slice(self.take(8));
        u64::from_le_bytes(a)
    }
    pub fn bytes(&mut self, out: &mut [u8]) {
        let n = out.len();
        out.copy_from_slice(self.take(n));
    }
    pub fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }
}
