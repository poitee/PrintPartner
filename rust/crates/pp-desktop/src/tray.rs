//! Tray status model: menu text and icon badge color per core status.
use pp_core::CoreStatus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ready,
    Busy,
    Stopped,
    Failed,
}

impl Tone {
    pub fn rgba(self) -> [u8; 4] {
        match self {
            Tone::Ready => [0x2e, 0x7d, 0x32, 0xff],
            Tone::Busy => [0xf9, 0xa8, 0x25, 0xff],
            Tone::Stopped => [0x75, 0x75, 0x75, 0xff],
            Tone::Failed => [0xc6, 0x28, 0x28, 0xff],
        }
    }
}

pub fn status(state: &CoreStatus) -> (&'static str, Tone) {
    match state {
        CoreStatus::Starting => ("Service starting", Tone::Busy),
        CoreStatus::Ready { .. } => ("Service ready", Tone::Ready),
        CoreStatus::Backoff { .. } => ("Service reconnecting", Tone::Busy),
        CoreStatus::Guarded => ("Service stopped after repeated failures", Tone::Failed),
        CoreStatus::Stopping => ("Service stopping", Tone::Busy),
        CoreStatus::Stopped => ("Service stopped", Tone::Stopped),
        CoreStatus::Failed => ("Service failed", Tone::Failed),
    }
}

/// Menu item ids in display order.
pub fn menu_ids() -> &'static [&'static str] {
    &[
        "show",
        "browser",
        "status",
        "logs",
        "log_folder",
        "recover",
        "data",
        "quit",
    ]
}

/// Copies an RGBA icon and paints an opaque status dot in its bottom-right quarter.
/// A buffer that does not hold width * height RGBA pixels comes back unchanged.
pub fn badge(rgba: &[u8], width: u32, height: u32, tone: Tone) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4));
    if expected != Some(out.len()) {
        return out;
    }
    let radius = (width.min(height) / 4).max(1) as i64;
    let (cx, cy) = (width as i64 - radius - 1, height as i64 - radius - 1);
    let color = tone.rgba();
    for y in (cy - radius).max(0)..=(cy + radius).min(height as i64 - 1) {
        for x in (cx - radius).max(0)..=(cx + radius).min(width as i64 - 1) {
            if (x - cx).pow(2) + (y - cy).pow(2) < radius.pow(2) {
                let at = ((y as usize) * (width as usize) + x as usize) * 4;
                out[at..at + 4].copy_from_slice(&color);
            }
        }
    }
    out
}
