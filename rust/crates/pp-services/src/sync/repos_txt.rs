//! `repos.txt` parsing, ported from `parseReposTxtLine`, `parseReposTxtText`
//! and the skip count in `importReposTxt` (`web/apps/server/src/services/repos-txt.ts`).

use super::github_url::js_trim;
use std::sync::OnceLock;

/// One Source a `repos.txt` line names.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ReposTxtLine {
    pub name: String,
    pub url: String,
    pub branch: String,
}

fn github_url_pattern() -> &'static regress::Regex {
    static URL: OnceLock<regress::Regex> = OnceLock::new();
    URL.get_or_init(|| {
        regress::Regex::with_flags(
            r"^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$",
            "i",
        )
        .expect("valid repos.txt URL pattern")
    })
}

fn is_none_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    url.is_empty() || lower == "none" || lower == "null"
}

/// A `name,url[,branch]` line, or a bare GitHub repository URL.
pub fn parse_repos_txt_line(line: &str) -> Option<ReposTxtLine> {
    let raw = js_trim(line);
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    let parts = raw.split(',').map(js_trim).collect::<Vec<_>>();
    if parts.len() >= 2 {
        let (name, url) = (parts[0], parts[1]);
        if name.is_empty() || is_none_url(url) {
            return None;
        }
        let branch = parts.get(2).copied().filter(|branch| !branch.is_empty());
        return Some(ReposTxtLine {
            name: name.into(),
            url: url.into(),
            branch: branch.unwrap_or("main").into(),
        });
    }
    let found = github_url_pattern().find(raw)?;
    Some(ReposTxtLine {
        name: raw[found.group(2)?].into(),
        url: raw.into(),
        branch: "main".into(),
    })
}

/// `text.split(/\r?\n/)`.
fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// Every Source line in a `repos.txt` file, in file order.
pub fn parse_repos_txt_text(text: &str) -> Vec<ReposTxtLine> {
    lines(text).filter_map(parse_repos_txt_line).collect()
}

/// Names of `name,none` / `name,null` / `name,` lines, which the import skips.
pub fn repos_txt_skipped_names(text: &str) -> Vec<String> {
    lines(text)
        .filter_map(|line| {
            let raw = js_trim(line);
            if raw.is_empty() || raw.starts_with('#') {
                return None;
            }
            let parts = raw.split(',').map(js_trim).collect::<Vec<_>>();
            (parts.len() >= 2 && is_none_url(parts[1])).then(|| parts[0].to_owned())
        })
        .collect()
}
