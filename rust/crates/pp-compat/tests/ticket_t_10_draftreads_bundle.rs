//! GRE-1056: the bundle names the community manifests directory Node reads.
//! Node's `manifest-apply.js` joins `../data/manifests` from `services/`, and
//! the server build copies `src/data` to `data` beside `desktop.js`.
use pp_compat::Bundle;
use std::path::Path;

#[test]
fn ticket_t_10_draftreads_bundle_names_node_community_manifests() {
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web");
    let server = web.join("apps/server");
    let bundle = Bundle {
        node: "/runtime/node".into(),
        entry: server.join("dist/current/desktop.js"),
        web_root: web.clone(),
        runtime_version: "test".into(),
        commit: "test".into(),
    };
    assert_eq!(
        bundle.community_manifests_dir(),
        Some(server.join("dist/current/data/manifests"))
    );

    // The layout the path relies on, checked against the Node sources.
    let src = server.join("src");
    assert!(src.join("desktop.ts").is_file());
    let apply = std::fs::read_to_string(src.join("services/manifest-apply.ts")).unwrap();
    assert!(apply.contains(r#""../data/manifests""#));
    assert!(src.join("data/manifests/registry-index.yaml").is_file());
    let package = std::fs::read_to_string(server.join("package.json")).unwrap();
    assert!(package.contains("--copy src/data data"));
    assert!(package.contains("--require-file data/manifests/registry-index.yaml"));
}
