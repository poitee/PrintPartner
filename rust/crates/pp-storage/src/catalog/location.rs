use super::*;
fn decode(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = value.bytes();
    while let Some(b) = input.next() {
        if b == b'%' {
            let a = (input.next()? as char).to_digit(16)?;
            let b = (input.next()? as char).to_digit(16)?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(b)
        }
    }
    String::from_utf8(bytes).ok()
}
fn segment(value: Option<String>) -> Result<String> {
    let value =
        value.ok_or_else(|| CatalogFailure::Input("Invalid GitHub location segment".into()))?;
    ensure!(
        !value.is_empty()
            && !matches!(value.as_str(), "." | "..")
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')),
        CatalogFailure::Input("Invalid GitHub location segment".into())
    );
    Ok(value)
}
fn normalize(url: &str, requested: Option<&str>) -> Option<Result<(String, String)>> {
    let url = trim(url);
    let requested = requested.map(trim).filter(|s| !s.is_empty());
    let ssh = match regress::Regex::with_flags(
        r"^git@github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?$",
        "i",
    ) {
        Ok(ssh) => ssh,
        Err(error) => return Some(Err(anyhow!("Invalid SSH location pattern: {error}"))),
    };
    if let Some(m) = ssh.find(url) {
        let owner = segment(decode(&url[m.captures[0].clone()?]));
        let repo = segment(decode(&url[m.captures[1].clone()?]));
        return Some(owner.and_then(|owner| {
            repo.map(|repo| {
                (
                    format!("https://github.com/{owner}/{repo}"),
                    requested.unwrap_or("main").into(),
                )
            })
        }));
    }

    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let (authority, path) = rest.split_once('/')?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("www.github.com") {
        return None;
    }
    let path = path.split(['?', '#']).next()?;
    let segments = path
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let owner = match segment(decode(segments.first()?)) {
        Ok(owner) => owner,
        Err(error) => return Some(Err(error)),
    };
    let repo = decode(segments.get(1)?).map(|mut repo| {
        if repo.to_lowercase().ends_with(".git") {
            repo.truncate(repo.len() - 4);
        }
        repo
    });
    let repo = match segment(repo) {
        Ok(repo) => repo,
        Err(error) => return Some(Err(error)),
    };
    let branch = if segments.len() == 2 {
        requested.unwrap_or("main").into()
    } else {
        if !matches!(segments.get(2)?.to_lowercase().as_str(), "tree" | "blob") {
            return None;
        }
        let branch = decode(segments.get(3)?)?;
        if branch.is_empty() {
            return None;
        }
        let tail = segments[3..]
            .iter()
            .map(|s| decode(s))
            .collect::<Option<Vec<_>>>()
            .map(|s| s.join("/"));
        requested
            .filter(|r| {
                tail.as_ref()
                    .is_some_and(|t| t == r || t.starts_with(&format!("{r}/")))
            })
            .map(str::to_owned)
            .unwrap_or(branch)
    };
    Some(Ok((format!("https://github.com/{owner}/{repo}"), branch)))
}
pub(super) fn create(source: &mut CreateSource) -> Result<()> {
    let kind = source
        .source_kind
        .as_deref()
        .unwrap_or("github")
        .to_lowercase();
    if matches!(kind.as_str(), "printables" | "makerworld" | "thangs")
        && source.url.as_deref().is_none_or(|s| trim(s).is_empty())
    {
        return Err(CatalogFailure::Input(format!("A {kind} model URL is required. Download the archive from the site and upload it after creating the source.")).into());
    }
    if matches!(kind.as_str(), "github" | "git")
        && let Some((url, branch)) = source
            .url
            .as_deref()
            .and_then(|u| normalize(u, source.branch.as_deref()))
            .transpose()?
    {
        source.url = Some(url);
        source.branch = Some(branch);
    }
    Ok(())
}
pub(super) fn update(existing: &SourceSummary, patch: &mut SourcePatch) -> Result<()> {
    let kind = patch
        .source_kind
        .as_deref()
        .unwrap_or(&existing.source_kind)
        .to_lowercase();
    if matches!(kind.as_str(), "github" | "git")
        && let Some((url, branch)) = patch
            .url
            .as_deref()
            .and_then(|u| normalize(u, patch.branch.as_deref().or(Some(&existing.branch))))
            .transpose()?
    {
        patch.url = Some(url);
        patch.branch = Some(branch);
    }
    Ok(())
}
