//! Orca Slicer / Bambu Studio profile discovery.
//!
//! Ported from `web/apps/server/src/services/slicer-instances.ts`
//! (`defaultWatchDirs`) and the presence checks in `profile-sync.ts`
//! (`buildProfileSyncSettings`). Layout observed for both slicers:
//!
//! ```text
//! <config root>/OrcaSlicer/user/default/{machine,process,filament}/*.json
//! <config root>/BambuStudio/user/default/{machine,process,filament}/*.json
//! ```
//!
//! The caller supplies the home dir and config root; nothing here reads the
//! environment, touches storage, or spawns processes.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Slicers this module knows how to discover.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlicerKind {
    Orca,
    Bambu,
}

impl SlicerKind {
    /// Parse a slicer instance kind (`"orca"`, `"bambu"`, ...). Any other kind,
    /// including `"prusa"` and `"custom"`, is unsupported here.
    pub fn from_kind(kind: &str) -> Option<Self> {
        match kind {
            "orca" => Some(Self::Orca),
            "bambu" => Some(Self::Bambu),
            _ => None,
        }
    }

    /// Parse a slicer dialect (`"orca_json"`, `"bambu_json"`, ...).
    pub fn from_dialect(dialect: &str) -> Option<Self> {
        match dialect {
            "orca_json" => Some(Self::Orca),
            "bambu_json" => Some(Self::Bambu),
            _ => None,
        }
    }

    /// Directory name under the config root.
    pub fn app_dir(self) -> &'static str {
        match self {
            Self::Orca => "OrcaSlicer",
            Self::Bambu => "BambuStudio",
        }
    }
}

/// Where the caller says to look. Neither path is required to exist.
#[derive(Clone, Debug)]
pub struct DiscoveryRoots {
    pub home_dir: PathBuf,
    /// Platform config root, e.g. `~/.config` or `~/Library/Application Support`.
    pub config_root: PathBuf,
}

impl DiscoveryRoots {
    /// Candidate app dirs: `config_root` first, then `home_dir/.config` (the
    /// layout the web server watches inside mounted slicer homes).
    fn candidates(&self, kind: SlicerKind) -> Vec<PathBuf> {
        let mut out = vec![self.config_root.join(kind.app_dir())];
        let home_config = self.home_dir.join(".config").join(kind.app_dir());
        if !out.contains(&home_config) {
            out.push(home_config);
        }
        out
    }
}

/// Profile directories under `<app dir>/user/default`, matching the web
/// server's `defaultWatchDirs`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileDirs {
    pub printer: PathBuf,
    pub process: PathBuf,
    pub filament: PathBuf,
}

impl ProfileDirs {
    fn under(app_dir: &Path) -> Self {
        let base = app_dir.join("user").join("default");
        Self {
            printer: base.join("machine"),
            process: base.join("process"),
            filament: base.join("filament"),
        }
    }
}

/// Profile files found in each directory, sorted by path.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileFiles {
    pub printer: Vec<PathBuf>,
    pub process: Vec<PathBuf>,
    pub filament: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredSlicer {
    pub kind: SlicerKind,
    pub app_dir: PathBuf,
    pub dirs: ProfileDirs,
    pub profiles: ProfileFiles,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Discovery {
    Present(DiscoveredSlicer),
    Absent,
    /// The requested kind is not Orca or Bambu.
    Unsupported,
}

/// Discover a slicer by instance kind string (`"orca"`, `"bambu"`, ...).
pub fn discover_kind(kind: &str, roots: &DiscoveryRoots) -> io::Result<Discovery> {
    match SlicerKind::from_kind(kind) {
        Some(kind) => discover(kind, roots),
        None => Ok(Discovery::Unsupported),
    }
}

/// A slicer is present when `<app dir>/user` exists (same check as
/// `buildProfileSyncSettings`). Missing profile subdirectories yield empty lists.
pub fn discover(kind: SlicerKind, roots: &DiscoveryRoots) -> io::Result<Discovery> {
    let Some(app_dir) = roots
        .candidates(kind)
        .into_iter()
        .find(|dir| dir.join("user").is_dir())
    else {
        return Ok(Discovery::Absent);
    };
    let dirs = ProfileDirs::under(&app_dir);
    let profiles = ProfileFiles {
        printer: list_json(&dirs.printer)?,
        process: list_json(&dirs.process)?,
        filament: list_json(&dirs.filament)?,
    };
    Ok(Discovery::Present(DiscoveredSlicer {
        kind,
        app_dir,
        dirs,
        profiles,
    }))
}

/// Discover every supported slicer, in Orca, Bambu order.
pub fn discover_all(roots: &DiscoveryRoots) -> io::Result<Vec<DiscoveredSlicer>> {
    let mut found = Vec::new();
    for kind in [SlicerKind::Orca, SlicerKind::Bambu] {
        if let Discovery::Present(slicer) = discover(kind, roots)? {
            found.push(slicer);
        }
    }
    Ok(found)
}

fn list_json(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut files = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "json") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod ticket_t_44_discovery {
    use super::*;

    fn fixture(case: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/discovery")
            .join(case)
            .join("home")
    }

    fn roots(case: &str) -> DiscoveryRoots {
        let home = fixture(case);
        DiscoveryRoots {
            config_root: home.join(".config"),
            home_dir: home,
        }
    }

    fn names(paths: &[PathBuf]) -> Vec<&str> {
        paths
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect()
    }

    #[test]
    fn present_orca_lists_json_profiles() {
        let Discovery::Present(orca) = discover(SlicerKind::Orca, &roots("present")).unwrap()
        else {
            panic!("orca should be present");
        };
        assert_eq!(orca.app_dir, fixture("present").join(".config/OrcaSlicer"));
        assert_eq!(orca.dirs.printer, orca.app_dir.join("user/default/machine"));
        assert_eq!(names(&orca.profiles.printer), ["My X1C.json"]);
        assert_eq!(names(&orca.profiles.process), ["0.20mm Fast.json"]);
        assert_eq!(names(&orca.profiles.filament), ["PLA Matte.json"]);
    }

    #[test]
    fn present_bambu_tolerates_missing_profile_dirs() {
        let Discovery::Present(bambu) = discover_kind("bambu", &roots("present")).unwrap() else {
            panic!("bambu should be present");
        };
        assert_eq!(bambu.kind, SlicerKind::Bambu);
        assert_eq!(names(&bambu.profiles.printer), ["Bambu P1S.json"]);
        assert!(bambu.profiles.process.is_empty());
        assert!(bambu.profiles.filament.is_empty());
    }

    #[test]
    fn present_falls_back_to_home_config_when_config_root_differs() {
        let home = fixture("present");
        let roots = DiscoveryRoots {
            config_root: home.join("Library/Application Support"),
            home_dir: home.clone(),
        };
        let found = discover_all(&roots).unwrap();
        assert_eq!(
            found.iter().map(|s| s.kind).collect::<Vec<_>>(),
            [SlicerKind::Orca, SlicerKind::Bambu]
        );
        assert_eq!(found[0].app_dir, home.join(".config/OrcaSlicer"));
    }

    #[test]
    fn absent_when_no_slicer_dirs() {
        assert_eq!(
            discover(SlicerKind::Orca, &roots("absent")).unwrap(),
            Discovery::Absent
        );
        assert_eq!(
            discover(SlicerKind::Bambu, &roots("absent")).unwrap(),
            Discovery::Absent
        );
        assert!(discover_all(&roots("absent")).unwrap().is_empty());
    }

    #[test]
    fn absent_when_roots_do_not_exist() {
        let missing = fixture("absent").join("does-not-exist");
        let roots = DiscoveryRoots {
            config_root: missing.join(".config"),
            home_dir: missing,
        };
        assert_eq!(
            discover(SlicerKind::Orca, &roots).unwrap(),
            Discovery::Absent
        );
    }

    #[test]
    fn unsupported_kinds_and_dialects() {
        let roots = roots("unsupported");
        for kind in ["prusa", "custom", "", "Orca"] {
            assert_eq!(
                discover_kind(kind, &roots).unwrap(),
                Discovery::Unsupported,
                "{kind:?}"
            );
        }
        assert_eq!(SlicerKind::from_dialect("prusa_ini"), None);
        assert_eq!(
            SlicerKind::from_dialect("orca_json"),
            Some(SlicerKind::Orca)
        );
        assert_eq!(
            SlicerKind::from_dialect("bambu_json"),
            Some(SlicerKind::Bambu)
        );
        // A Prusa-only home has no Orca/Bambu install.
        assert!(discover_all(&roots).unwrap().is_empty());
    }
}
