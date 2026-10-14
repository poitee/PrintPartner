# Profile interpreter test provenance

The focused tests use expectations from the Node capture at commit `d73b6d8d250b84e22b37262a0c2720d4f777a0ca`, in `rust/crates/pp-core/tests/fixtures/profile-parser/node-capture.json` on the reference branch `desktop/source-sync-local-current-20261008`.

| Focused test | Capture cases or repository rows |
| --- | --- |
| `duplicate_values_keep_first_key_position_and_node_index_order` | `duplicate-to-null` supplies the empty resolved object. |
| `numeric_stringification_and_projection_follow_javascript` | `numeric-edges` supplies the resolved JSON; Below Half PLA, Large Integral PLA and Huge PLA supply rounding expectations. |
| `captured_surrogate_parent_request_and_flat_config_preserve_utf16` | `surrogate-fields` supplies the raw input and resolved JSON. |
| `invalid_utf8_uses_node_replacement_before_json_parsing` | Utf8Ff, Utf8Overlong and Utf8Continuation supply input bytes and replacement expectations. |

D2a includes selected literal expectations. D2b will add the unchanged full capture and its remaining interpreter tests after D2a lands on main.
