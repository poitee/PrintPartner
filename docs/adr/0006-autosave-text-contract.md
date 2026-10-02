# Autosave text contains Unicode scalar values

Status: accepted modernization for the desktop contract boundary.

The existing Node parser accepted escaped lone UTF-16 surrogates in autosave `source_layer` and receipt `applied_at`. The measured Rust serde_json parser rejected them before DTO validation. A JavaScript string can contain unpaired surrogates, but Rust String contains valid UTF-8. The earlier corpus covered supplementary-plane emoji bounds and missed this difference.

Autosave text now contains Unicode scalar values. The Node schema rejects unpaired surrogates in `decisions[].target.part_key`, `relative_path`, nullable `source_layer`, and receipt `applied_at`. Their existing bounds stay unchanged. Digests already require 64 lowercase hexadecimal characters and need no new rule. Other workspace, source, filename, role and unrelated contract text schemas retain their existing behavior.

The Node refinement uses a Unicode-mode regex that detects a surrogate code point. A valid UTF-16 surrogate pair is interpreted as one supplementary code point and is preserved. The executable cases compare this predicate with the standard `String.prototype.isWellFormed` result under Node 22 and 24. The [ECMAScript algorithm](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.iswellformed) defines well-formed Unicode text. A local predicate keeps the existing TypeScript library target and browser requirements intact.

Both boundaries reject malformed text under the semantic category `invalid_unicode_scalar_text`. Node emits a Zod custom issue with the affected field path. Rust rejects malformed JSON string escapes during serde_json decoding. Diagnostic wording and path presentation remain implementation-specific. Acceptance, parsed values and serialized receipt identities must match exactly.

The intentional compatibility change rejects inputs containing unpaired surrogates. No valid scalar value changes, no normalization occurs, and no string is repaired with a replacement character. Existing persisted records are not rewritten. Node continues to own complete autosave transactions and publication receipts. This unit does not add a second validation pass to forwarded saves or migrate the database.

The three existing Zod objects are intentionally exported for native [JSON Schema conversion](https://zod.dev/json-schema). Custom refinements remain authoritative; JSON Schema does not encode all relational, duplicate-target or scalar-text rules. The generated semantic rules disclose those limits. Rust applies them through validated DTO deserialization and constructors.

The unchanged golden contributes 41 parser cases and five real route receipts. Separate cases reject lone high and low surrogates and reversed pairs in each affected field. They preserve valid pairs and mixed text. Codepoint controls accept 1000 emoji and reject 1001. External Rust consumer tests read validated request data and construct exact receipts from validated components. Named schema and parity commands fail on drift without refreshing the golden.
