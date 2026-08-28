# Print Partner documentation

Use this index to find the guide for your task. The in-app Help page covers the product workflow.

## Start here

| Guide | Use it when |
|-------|-------------|
| [Install](INSTALL.md) | You are setting up the Docker container or opening Print Partner on a LAN. |
| [Operations](../OPERATIONS.md) | You need backups, recovery, API keys, metrics, logs, or update steps. |
| [MCP setup](assistant-mcp.md) | You want to connect Cursor, Claude, or another MCP client. |
| [Deployment reference](../web/DEPLOY.md) | You need environment variables, authentication, OAuth, S3, or SaaS settings. |

## Product workflow

| Area | Browser path | Task |
|------|--------------|------|
| Library | `/library` | Register and sync shared source repositories. |
| Builds | `/builds` | Create, open, copy, archive, or restore a build. |
| Sources | `/sources?profile=<id>` | Attach sources and select STL files for the active build. |
| Plan | `/plan?profile=<id>` | Review quantities and apply a draft. |
| Checkoff | `/progress?profile=<id>` | Track required units through printing and assembly. |
| Production | `/export?profile=<id>` | Arrange plates, export files, and send sliced jobs. |
| Production overview | `/production` | Review remaining work across builds. |

## Setup and integrations

- [Printer connections](integrations/PRINTER_SETUP.md)
- [Spoolman](integrations/SPOOLMAN.md)
- [3MF export validation](3MF_EXPORT_VALIDATION.md)
- [Manifest authoring](playbooks/author-manifest-on-stack.md)
- [Stack presets and variants](playbooks/kit-studio-build.md)

## Reference

- [Architecture](ARCHITECTURE.md)
- [HTTP API](API.md)
- [Manifest format](../manifests/README.md)
- [Security](../SECURITY.md)
- [Release history](../CHANGELOG.md)
- [Autopilot](agents/autopilot.md)

## Examples

- [Golden LDO Voron 2.4 with SB Tap](examples/golden-ldo-voron-2.4-sb-tap.md)
- [Golden kit export](examples/golden-ldo-voron-2.4-export.md)
- [Cross-source Voron stack](examples/cross-source-voron/ldo-2.4-golden-stack.md)

## Project media

- [Project site](https://poitee.github.io/PrintPartner/)
- [Screenshot capture guide](screenshots/README.md)
