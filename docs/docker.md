# Docker image

The Docker image runs the Rust core headless for one user. It is the only headless mode. There is no launchd, systemd or Windows Service mode. This page is a stub until the Docker milestone builds the Rust image.

[Install](INSTALL.md) describes the current image, which runs the Node server.

## Scope

- One user. The image has no multi-user accounts, no hosted SaaS mode and no Postgres.
- The web UI requires sign-in.
- The image runs `pp-server`.

## To be written

- How to run the image with `docker compose`.
- Volumes and the data directory layout.
- Health and readiness endpoints.
- Upgrade, backup and restore.
- How to import data from the current Node image's volume.
