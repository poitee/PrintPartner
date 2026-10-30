//! HTTP Digest authentication (RFC 7616, MD5 and MD5-sess, `qop=auth`),
//! ported from `web/apps/server/src/integrations/digest-auth.ts`.
use crate::moonraker_driver::js_trim;
use anyhow::{Result, bail};
use md5::{Digest, Md5};
use std::collections::BTreeMap;

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript's line terminators, which `.` does not match.
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Challenge parameters with lowercased names. Empty when the header is not a
/// Digest challenge. Matches Node's `/^\s*Digest\s+(.+)$/i`, then a global
/// `/(\w+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]*))/g` scan with unescaping.
pub fn parse_www_authenticate(header: &str) -> BTreeMap<String, String> {
    let mut params = BTreeMap::new();
    let header = js_trim(header);
    let Some(rest) = header
        .get(..6)
        .filter(|scheme| scheme.eq_ignore_ascii_case("digest"))
        .map(|_| &header[6..])
        .filter(|rest| {
            rest.starts_with(js_space) && !rest.trim_start_matches(js_space).contains(line_end)
        })
    else {
        return params;
    };
    let chars: Vec<char> = rest.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let name_end = (i..chars.len())
            .find(|&j| !word(chars[j]))
            .unwrap_or(chars.len());
        if name_end == i || chars.get(name_end) != Some(&'=') {
            i = name_end.max(i + 1);
            continue;
        }
        let name: String = chars[i..name_end].iter().collect();
        let value_start = name_end + 1;
        let (value, end) = match quoted(&chars, value_start) {
            Some(found) => found,
            None => {
                let end = (value_start..chars.len())
                    .find(|&j| chars[j] == ',' || js_space(chars[j]))
                    .unwrap_or(chars.len());
                (chars[value_start..end].iter().collect(), end)
            }
        };
        params.insert(name.to_ascii_lowercase(), value);
        i = end;
    }
    params
}

/// An unescaped quoted string at `start`, and the index after its closing quote.
fn quoted(chars: &[char], start: usize) -> Option<(String, usize)> {
    (chars.get(start) == Some(&'"')).then_some(())?;
    let mut value = String::new();
    let mut j = start + 1;
    loop {
        match *chars.get(j)? {
            '"' => return Some((value, j + 1)),
            '\\' => {
                let escaped = *chars.get(j + 1).filter(|c| !line_end(**c))?;
                value.push(escaped);
                j += 2;
            }
            c => {
                value.push(c);
                j += 1;
            }
        }
    }
}

fn md5(value: &str) -> String {
    hex::encode(Md5::digest(value.as_bytes()))
}

fn quote(value: &str) -> Result<String> {
    if value.contains(['\r', '\n', '\0']) {
        bail!("Invalid digest parameter");
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

/// `auth` when offered; `None` for a legacy challenge without `qop`.
fn pick_qop(raw: &str) -> Result<Option<&'static str>> {
    let options: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if options.iter().any(|o| o == "auth") {
        return Ok(Some("auth"));
    }
    if !options.is_empty() {
        bail!("Unsupported digest qop: {raw}");
    }
    Ok(None)
}

pub struct Request<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub method: &'a str,
    pub uri: &'a str,
    pub nc: u32,
    /// Client nonce; [`cnonce`] makes a fresh one.
    pub cnonce: &'a str,
}

/// A fresh 16-hex-digit client nonce, as Node's `randomBytes(8)`.
pub fn cnonce() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// The `Authorization` header value answering `challenge`.
pub fn authorization(request: &Request, challenge: &BTreeMap<String, String>) -> Result<String> {
    let get = |key: &str| challenge.get(key).map_or("", String::as_str);
    let (realm, nonce) = (get("realm"), get("nonce"));
    let qop = pick_qop(get("qop"))?;
    let algorithm = challenge
        .get("algorithm")
        .map_or("MD5".into(), |a| a.to_uppercase());
    if algorithm != "MD5" && algorithm != "MD5-SESS" {
        bail!("Unsupported digest algorithm: {algorithm}");
    }
    if request.nc == 0 {
        bail!("Invalid digest nc");
    }
    let Request {
        username,
        password,
        method,
        uri,
        cnonce,
        ..
    } = *request;
    let mut ha1 = md5(&format!("{username}:{realm}:{password}"));
    if algorithm == "MD5-SESS" {
        ha1 = md5(&format!("{ha1}:{nonce}:{cnonce}"));
    }
    let ha2 = md5(&format!("{method}:{uri}"));
    let nc = format!("{:08x}", request.nc);
    let response = match qop {
        Some(qop) => md5(&format!("{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}")),
        None => md5(&format!("{ha1}:{nonce}:{ha2}")),
    };
    let mut parts = vec![
        format!("Digest username={}", quote(username)?),
        format!("realm={}", quote(realm)?),
        format!("nonce={}", quote(nonce)?),
        format!("uri={}", quote(uri)?),
        format!("response={}", quote(&response)?),
    ];
    if let Some(qop) = qop {
        parts.push(format!("qop={qop}"));
        parts.push(format!("nc={nc}"));
        parts.push(format!("cnonce={}", quote(cnonce)?));
    } else if algorithm == "MD5-SESS" {
        // MD5-sess folds cnonce into HA1, so the server needs it even without qop.
        parts.push(format!("cnonce={}", quote(cnonce)?));
    }
    if let Some(opaque) = challenge.get("opaque").filter(|o| !o.is_empty()) {
        parts.push(format!("opaque={}", quote(opaque)?));
    }
    parts.push(format!("algorithm={algorithm}"));
    Ok(parts.join(", "))
}
