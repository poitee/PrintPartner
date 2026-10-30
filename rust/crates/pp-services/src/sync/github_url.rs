//! GitHub repository URLs and refs, ported from `parseGithubUrl`,
//! `resolveGithubUrlRef`, `githubRefName` and `normalizeGithubSourceLocation`
//! in `web/apps/server/src/services/github-sync.ts`.

use std::sync::OnceLock;

/// A GitHub repository and the ref its URL names.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoRef {
    pub owner: String,
    pub repo: String,
    /// The first ref segment of a `tree`/`blob` URL, or `main`.
    pub branch: String,
    /// True when `branch` came from a `tree`/`blob` URL.
    pub branch_from_url: bool,
}

/// A Source location rewritten to its canonical GitHub URL.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct SourceLocation {
    pub url: String,
    pub branch: String,
}

/// `String.prototype.trim` whitespace: WhiteSpace plus LineTerminator.
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

/// `decodeURIComponent`, with `None` where it throws `URIError`.
fn decode_uri_component(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut rest = value.as_bytes();
    while let Some((&byte, tail)) = rest.split_first() {
        if byte == b'%' {
            let hex = tail.get(..2)?;
            let text = std::str::from_utf8(hex).ok()?;
            bytes.push(u8::from_str_radix(text, 16).ok()?);
            rest = &tail[2..];
        } else {
            bytes.push(byte);
            rest = tail;
        }
    }
    String::from_utf8(bytes).ok()
}

/// `None` only if the constant pattern fails to compile, which the parity tests rule out.
fn ssh_pattern() -> Option<&'static regress::Regex> {
    static SSH: OnceLock<Option<regress::Regex>> = OnceLock::new();
    SSH.get_or_init(|| {
        regress::Regex::with_flags(r"^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$", "i").ok()
    })
    .as_ref()
}

/// Path segments of a WHATWG URL, as `pathname.split("/").filter(Boolean)`.
fn url_segments(url: &str) -> Option<Vec<String>> {
    let parsed = url::Url::parse(url).ok()?;
    Some(
        parsed
            .path()
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// Parses an SSH or `http(s)://github.com` repository URL.
pub fn parse_github_url(url: &str) -> Option<GithubRepoRef> {
    let trimmed = js_trim(url);
    if let Some(found) = ssh_pattern()?.find(trimmed) {
        let owner = &trimmed[found.group(1)?];
        let repo = &trimmed[found.group(2)?];
        return Some(GithubRepoRef {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            branch: "main".into(),
            branch_from_url: false,
        });
    }

    let parsed = url::Url::parse(trimmed).ok()?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if !matches!(parsed.scheme(), "https" | "http")
        || (host != "github.com" && host != "www.github.com")
    {
        return None;
    }
    let segments = url_segments(trimmed)?;
    if segments.len() < 2 {
        return None;
    }
    let owner = decode_uri_component(&segments[0]).filter(|owner| !owner.is_empty())?;
    let repo = decode_uri_component(&segments[1])
        .map(|repo| strip_git_suffix(&repo).to_owned())
        .filter(|repo| !repo.is_empty())?;
    if segments.len() == 2 {
        return Some(GithubRepoRef {
            owner,
            repo,
            branch: "main".into(),
            branch_from_url: false,
        });
    }
    let page = segments[2].to_lowercase();
    if (page != "tree" && page != "blob") || segments.get(3).is_none_or(String::is_empty) {
        return None;
    }
    let branch = decode_uri_component(&segments[3]).filter(|branch| !branch.is_empty())?;
    Some(GithubRepoRef {
        owner,
        repo,
        branch,
        branch_from_url: true,
    })
}

/// `/\.git$/i` removal.
fn strip_git_suffix(repo: &str) -> &str {
    let split = repo.len().saturating_sub(4);
    match repo.get(split..) {
        Some(tail) if tail.eq_ignore_ascii_case(".git") => &repo[..split],
        _ => repo,
    }
}

/// Every decoded segment after `tree`/`blob`, joined with `/`.
pub(crate) fn deep_github_ref_tail(url: &str) -> Option<String> {
    let segments = url_segments(js_trim(url))?;
    let page = segments.get(2)?.to_lowercase();
    if (page != "tree" && page != "blob") || segments.get(3).is_none_or(String::is_empty) {
        return None;
    }
    let decoded = segments[3..]
        .iter()
        .map(|segment| decode_uri_component(segment))
        .collect::<Option<Vec<_>>>()?;
    Some(decoded.join("/"))
}

/// Resolves the longest known ref that prefixes a deep GitHub URL's tail.
pub fn resolve_github_url_ref<S: AsRef<str>>(url: &str, known_refs: &[S]) -> Option<String> {
    let tail = deep_github_ref_tail(url)?;
    let mut matched: Option<&str> = None;
    for raw in known_refs {
        let candidate = js_trim(raw.as_ref());
        if candidate.is_empty()
            || (tail != candidate && !tail.starts_with(&format!("{candidate}/")))
        {
            continue;
        }
        if matched.is_none_or(|current| utf16_len(candidate) > utf16_len(current)) {
            matched = Some(candidate);
        }
    }
    matched.map(str::to_owned)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The ref a Source names, without any network lookup.
pub fn github_ref_name(url: &str, requested: Option<&str>) -> Option<String> {
    let parsed = parse_github_url(url)?;
    let requested = requested.map(js_trim).filter(|value| !value.is_empty());
    if !parsed.branch_from_url {
        return Some(requested.map_or(parsed.branch, str::to_owned));
    }
    Some(
        requested
            .and_then(|value| resolve_github_url_ref(url, &[value]))
            .unwrap_or(parsed.branch),
    )
}

/// The canonical `https://github.com/{owner}/{repo}` location and its ref.
pub fn normalize_github_source_location(url: &str, branch: Option<&str>) -> Option<SourceLocation> {
    let parsed = parse_github_url(url)?;
    Some(SourceLocation {
        url: format!("https://github.com/{}/{}", parsed.owner, parsed.repo),
        branch: github_ref_name(url, branch).unwrap_or(parsed.branch),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_uri_component_refuses_what_javascript_refuses() {
        assert_eq!(decode_uri_component("a%2Fb").as_deref(), Some("a/b"));
        assert_eq!(decode_uri_component("%C3%A9").as_deref(), Some("é"));
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%C3"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
    }

    #[test]
    fn strip_git_suffix_ignores_case_and_short_names() {
        assert_eq!(strip_git_suffix("Repo.GIT"), "Repo");
        assert_eq!(strip_git_suffix(".git"), "");
        assert_eq!(strip_git_suffix("git"), "git");
        assert_eq!(strip_git_suffix("é.git"), "é");
    }
}
