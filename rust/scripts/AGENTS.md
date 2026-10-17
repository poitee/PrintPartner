# rust/scripts

| Rule | Enforcement |
| --- | --- |
| Desktop staging accepts a supplied Node path only when the resolved file is a Linux ELF or macOS Mach-O image, then checks Node 24.21.0 ABI 137 and the host platform. A dispatcher script is rejected before the stager runs that file or creates the stage directory. | `native_node_binary` in `rust/scripts/stage-desktop.py`. Run `python3 rust/scripts/stage-desktop.py --self-test`. |
| Each `pp-*` crate may depend only on the `pp-*` crates listed for it in `ALLOWED`. The `GATED` edges (pp-core → pp-source and pp-net; pp-storage → pp-domain and pp-contracts) must be optional dependencies that only the default-off `desktop_rebuild` feature enables. | `ALLOWED`, `GATED` and `rebuild_edge_is_gated` in `rust/scripts/check-boundaries.py`. Run `python3 rust/scripts/check-boundaries.py --self-test`. |
