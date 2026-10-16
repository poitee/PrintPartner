# Network sharing

The desktop app's "Share on network" setting serves the web UI to phones, tablets and other computers on the local network. This page will describe how to turn it on and how access is protected. The feature does not exist yet. Today the Rust gateway listens on loopback only.

## Rules

- Sharing is off by default.
- Every device on the network must sign in or pair with the desktop app before it can use the UI.

## To be written

The API milestone fills in these sections:

- Sign-in and sessions for a single user.
- Device pairing with a code or a QR code.
- Optional TLS and mDNS discovery.
- The firewall self-test.
- How the gateway checks the `Host` and `Origin` headers.

The Docker image does not use this setting. It requires sign-in. See [Docker image](docker.md).
