//! Unicode 16 NFC for paths already stored in a snapshot manifest.
//!
//! `unicode-normalization` 0.1.25 uses Unicode 17. Compared with 0.1.24, the
//! only canonical combining-class changes are 34 scalars that left class 0.
//! Canonical decompositions did not change. U+1ADE and U+1ADF were already
//! class 0, so the Tai Tham range includes them without altering their class.
//! New writes still use Unicode 17 NFC.

use unicode_normalization::char::{canonical_combining_class, compose, decompose_canonical};

fn ccc16(c: char) -> u8 {
    match c as u32 {
        0x10EFA | 0x10EFB | 0x1ACF..=0x1AEB | 0x1E6E3 | 0x1E6E6 | 0x1E6EE | 0x1E6EF | 0x1E6F5 => 0,
        _ => canonical_combining_class(c),
    }
}

struct Decomp {
    chars: Vec<char>,
    pos: usize,
    buffer: Vec<(u8, char)>,
    ready_start: usize,
    ready_end: usize,
}

impl Decomp {
    fn push_back(&mut self, ch: char) {
        let class = ccc16(ch);
        if class == 0 {
            self.sort_pending();
            self.buffer.push((class, ch));
            self.ready_end = self.buffer.len();
        } else {
            self.buffer.push((class, ch));
        }
    }
    fn sort_pending(&mut self) {
        self.buffer[self.ready_end..].sort_by_key(|item| item.0);
    }
    fn reset_buffer(&mut self) {
        let pending = self.buffer.len() - self.ready_end;
        for i in 0..pending {
            self.buffer[i] = self.buffer[i + self.ready_end];
        }
        self.buffer.truncate(pending);
        self.ready_start = 0;
        self.ready_end = 0;
    }
    fn increment_next_ready(&mut self) {
        let next = self.ready_start + 1;
        if next == self.ready_end {
            self.reset_buffer();
        } else {
            self.ready_start = next;
        }
    }
    fn next_char(&mut self) -> Option<char> {
        while self.ready_end == 0 {
            if self.pos < self.chars.len() {
                let ch = self.chars[self.pos];
                self.pos += 1;
                let mut produced = Vec::new();
                decompose_canonical(ch, |item| produced.push(item));
                for item in produced {
                    self.push_back(item);
                }
            } else if self.buffer.is_empty() {
                return None;
            } else {
                self.sort_pending();
                self.ready_end = self.buffer.len();
                break;
            }
        }
        let (_, ch) = self.buffer[self.ready_start];
        self.increment_next_ready();
        Some(ch)
    }
}

enum State {
    Composing,
    Purging(usize),
    Finished(usize),
}

struct Recomp {
    decomp: Decomp,
    state: State,
    buffer: Vec<char>,
    composee: Option<char>,
    last_ccc: Option<u8>,
}

impl Iterator for Recomp {
    type Item = char;
    fn next(&mut self) -> Option<char> {
        loop {
            match self.state {
                State::Composing => {
                    while let Some(ch) = self.decomp.next_char() {
                        let ch_class = ccc16(ch);
                        let k = match self.composee {
                            None => {
                                if ch_class != 0 {
                                    return Some(ch);
                                }
                                self.composee = Some(ch);
                                continue;
                            }
                            Some(k) => k,
                        };
                        match self.last_ccc {
                            None => match compose(k, ch) {
                                Some(composed) => {
                                    self.composee = Some(composed);
                                    continue;
                                }
                                None => {
                                    if ch_class == 0 {
                                        self.composee = Some(ch);
                                        return Some(k);
                                    }
                                    self.buffer.push(ch);
                                    self.last_ccc = Some(ch_class);
                                }
                            },
                            Some(previous) => {
                                if previous >= ch_class {
                                    if ch_class == 0 {
                                        self.composee = Some(ch);
                                        self.last_ccc = None;
                                        self.state = State::Purging(0);
                                        return Some(k);
                                    }
                                    self.buffer.push(ch);
                                    self.last_ccc = Some(ch_class);
                                    continue;
                                }
                                match compose(k, ch) {
                                    Some(composed) => {
                                        self.composee = Some(composed);
                                        continue;
                                    }
                                    None => {
                                        self.buffer.push(ch);
                                        self.last_ccc = Some(ch_class);
                                    }
                                }
                            }
                        }
                    }
                    self.state = State::Finished(0);
                    if self.composee.is_some() {
                        return self.composee.take();
                    }
                }
                State::Purging(next) => match self.buffer.get(next).copied() {
                    None => {
                        self.buffer.clear();
                        self.state = State::Composing;
                    }
                    Some(ch) => {
                        self.state = State::Purging(next + 1);
                        return Some(ch);
                    }
                },
                State::Finished(next) => match self.buffer.get(next).copied() {
                    None => {
                        self.buffer.clear();
                        return self.composee.take();
                    }
                    Some(ch) => {
                        self.state = State::Finished(next + 1);
                        return Some(ch);
                    }
                },
            }
        }
    }
}

pub(crate) fn nfc16(input: &str) -> String {
    Recomp {
        decomp: Decomp {
            chars: input.chars().collect(),
            pos: 0,
            buffer: Vec::new(),
            ready_start: 0,
            ready_end: 0,
        },
        state: State::Composing,
        buffer: Vec::new(),
        composee: None,
        last_ccc: None,
    }
    .collect()
}

#[cfg(test)]
mod tests {
    use super::nfc16;
    use unicode_normalization::UnicodeNormalization;

    #[test]
    fn tai_tham_sequences_keep_their_unicode_16_spelling() {
        let legacy = "a\u{1ADD}\u{0300}.stl";
        assert_eq!(nfc16(legacy), legacy);
        assert_ne!(legacy.nfc().collect::<String>(), legacy);
        let blocker = "a\u{1ACF}\u{0300}";
        assert_eq!(nfc16(blocker), blocker);
        assert_eq!(nfc16("\u{00E0}\u{1ADD}.stl"), "\u{00E0}\u{1ADD}.stl");
        assert_eq!(nfc16("cafe\u{301}"), "café");
        assert_eq!(nfc16("\u{212B}"), "\u{00C5}");
        assert_eq!(nfc16("\u{1100}\u{1161}"), "\u{AC00}");
    }
}
