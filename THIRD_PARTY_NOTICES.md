# Third-party notices

This file lists the direct runtime dependencies declared by the `web` workspaces and the licenses reported by their installed package manifests. Run `npm run docs:licenses` from `web` after changing runtime dependencies.

Transitive packages are recorded in `web/package-lock.json` and remain subject to their own licenses. Print Partner's license and project credit are documented in [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md).

## npm packages (direct dependencies)

| Package | Version | License | URL |
|---------|---------|---------|-----|
| @aws-sdk/client-s3 | 3.1114.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-s3 |
| @dnd-kit/core | 6.3.1 | MIT | https://github.com/clauderic/dnd-kit |
| @dnd-kit/sortable | 10.0.0 | MIT | https://github.com/clauderic/dnd-kit |
| @dnd-kit/utilities | 3.2.2 | MIT | https://github.com/clauderic/dnd-kit |
| @fastify/cookie | 11.1.2 | MIT | https://github.com/fastify/fastify-cookie#readme |
| @fastify/cors | 11.3.0 | MIT | https://github.com/fastify/fastify-cors#readme |
| @fastify/multipart | 10.1.1 | MIT | https://github.com/fastify/fastify-multipart#readme |
| @fastify/rate-limit | 11.2.0 | MIT | https://github.com/fastify/fastify-rate-limit#readme |
| @fastify/static | 10.1.3 | MIT | https://github.com/fastify/fastify-static |
| @fastify/swagger | 9.8.1 | MIT | https://github.com/fastify/fastify-swagger#readme |
| @fastify/swagger-ui | 6.1.1 | MIT | https://github.com/fastify/fastify-swagger-ui#readme |
| @fastify/websocket | 11.3.0 | MIT | https://github.com/fastify/fastify-websocket#readme |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | https://modelcontextprotocol.io |
| @octokit/rest | 22.0.1 | MIT | https://github.com/octokit/rest.js |
| @radix-ui/react-dialog | 1.1.23 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-dropdown-menu | 2.1.24 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-label | 2.1.15 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-popover | 1.1.23 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-select | 2.3.7 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-separator | 1.1.15 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-slot | 1.3.3 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-switch | 1.3.7 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-tabs | 1.1.21 | MIT | https://radix-ui.com/primitives |
| @radix-ui/react-tooltip | 1.2.16 | MIT | https://radix-ui.com/primitives |
| @tailwindcss/vite | 4.3.3 | MIT | https://tailwindcss.com |
| @tanstack/react-query | 5.101.4 | MIT | https://tanstack.com/query |
| adm-zip | 0.6.0 | MIT | https://github.com/cthackers/adm-zip |
| better-sqlite3 | 12.11.1 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| chokidar | 4.0.3 | MIT | https://github.com/paulmillr/chokidar |
| class-variance-authority | 0.7.1 | Apache-2.0 | https://github.com/joe-bell/cva#readme |
| clsx | 2.1.1 | MIT | https://github.com/lukeed/clsx |
| cmdk | 1.1.1 | MIT | https://github.com/pacocoursey/cmdk#readme |
| dockerode | 5.0.1 | Apache-2.0 | https://github.com/apocas/dockerode |
| drizzle-orm | 0.45.2 | Apache-2.0 | https://orm.drizzle.team |
| fastify | 5.12.1 | MIT | https://fastify.dev/ |
| fflate | 0.8.3 | MIT | https://101arrowz.github.io/fflate |
| js-yaml | 5.3.0 | MIT | https://github.com/nodeca/js-yaml |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | https://github.com/Stuk/jszip |
| lucide-react | 1.33.0 | ISC | https://lucide.dev |
| mqtt | 5.15.2 | MIT | https://github.com/mqttjs/MQTT.js |
| nodemailer | 9.0.5 | MIT-0 | https://nodemailer.com/ |
| pdf-parse | 2.4.5 | Apache-2.0 | https://mehmet-kozan.github.io/pdf-parse/ |
| pg | 8.23.0 | MIT | https://github.com/brianc/node-postgres |
| pino | 10.3.1 | MIT | https://getpino.io |
| react | 19.2.8 | MIT | https://react.dev/ |
| react-dom | 19.2.8 | MIT | https://react.dev/ |
| react-router-dom | 7.18.2 | MIT | https://github.com/remix-run/react-router |
| sonner | 2.0.8 | MIT | https://sonner.emilkowal.ski/ |
| tailwind-merge | 3.6.0 | MIT | https://github.com/dcastil/tailwind-merge |
| tar | 7.5.22 | BlueOak-1.0.0 | https://github.com/isaacs/node-tar |
| three | 0.185.1 | MIT | https://threejs.org/ |
| zod | 4.4.3 | MIT | https://zod.dev |

Versions reflect the installed dependency tree used to generate this file.

## 3MF export

Print Partner writes 3MF archives using **fflate** (ZIP) and hand-authored Core + Materials XML. It does **not** bundle native **lib3mf**.

## Optional external tool: stl-thumb

If installed on your system `PATH`, Print Partner may invoke **stl-thumb** for faster STL thumbnails:

- Project: https://github.com/unlimitedbacon/stl-thumb
- License: MIT

Print Partner does not bundle stl-thumb; install it separately if desired.

## User-provided content

STL files, Git repositories, and kit data you import remain subject to **their own** licenses and terms. Print Partner does not claim ownership of your models or third-party repo content.

## Printer preset names

Built-in printer presets use common printer model names for bed-size hints only. Print Partner is **not affiliated with or endorsed by** any printer manufacturer (including names such as Bambu Lab, Prusa Research, or Voron Design).
