# STL downloads and browser warnings

## Export capacity

Sorted STL downloads have no application-level cap on total source bytes, output bytes, or selected copies. The previous 256 MiB, 512 MiB, and 10,000-copy caps no longer apply.

Each selected copy remains a separate STL file. The server stages those files and a compressed ZIP on disk. ZIP creation streams one input at a time and uses ZIP64 when needed. Disk capacity, available memory for file metadata, filesystem constraints, and proxy timeouts still apply. Removing export caps does not remove authentication, path validation, or artifact hash verification.

These changes apply to sorted STL downloads. Upload, Plan quantity, and 3MF plate-generation safeguards are separate.

## Chrome warnings

Chrome distinguishes insecure connections, uncommon downloads, and malicious-file detections. Correct ZIP headers do not override Chrome's security checks. See [Google's explanation of blocked downloads](https://support.google.com/chrome/answer/6261569?hl=en).

An address such as `http://192.168.200.80:8080` uses unencrypted HTTP. For an insecure-download warning, serve PrintPartner through HTTPS with a certificate trusted by the downloading computer. Both the page and its download URL must use HTTPS without redirecting to HTTP. A local certificate authority must be trusted on each client; an untrusted self-signed certificate is not a complete solution.

A malicious-file or Safe Browsing warning requires the exact warning text, source URL, and affected ZIP to investigate. HTTPS alone does not clear a malware verdict. Do not disable Safe Browsing or rename the file to evade the warning.

The download endpoint sends `application/zip`, attachment filenames encoded for Unicode, and `X-Content-Type-Options: nosniff`. These headers describe the file correctly; they are not a safety verdict.
