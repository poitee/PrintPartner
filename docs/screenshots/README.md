# Capture screenshots

The README and project site use six screenshots in light and dark themes. Each image is a 1440 by 900 PNG captured from the running application.

## Files

```text
docs/screenshots/
├── light/
│   ├── library.png
│   ├── builds.png
│   ├── sources.png
│   ├── plan.png
│   ├── checkoff.png
│   └── production.png
└── dark/
    └── same filenames
```

The filenames match the screen labels. Do not reuse a filename for a different route.

## Prepare representative data

The capture should show a real Build with enough data to explain the workflow:

1. Add and sync at least one source containing STL files.
2. Create a Build and attach that source.
3. Select files and quantities.
4. Apply the Plan.
5. Arrange at least one Plate when possible.

Avoid personal paths, credentials, private repository names, or real customer data.

## Install capture dependencies

```bash
cd docs/scripts
npm ci
npx playwright install chromium
```

## Run the app

Start the single-port Docker build or another instance reachable at `http://localhost:8080`.

```bash
docker compose up --build -d
```

## Capture both themes

From the repository root:

```bash
node docs/scripts/capture-screenshots.mjs --theme light
node docs/scripts/capture-screenshots.mjs --theme dark
```

Use a specific Build when the instance contains more than one:

```bash
node docs/scripts/capture-screenshots.mjs --theme light --profile-id 1
node docs/scripts/capture-screenshots.mjs --theme dark --profile-id 1
```

Optional flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--url` | `http://localhost:8080` | Application base URL |
| `--theme` | `light` | `light` or `dark` |
| `--profile-id` | unset | Build to select before capture |
| `--out` | `docs/screenshots/<theme>` | Output directory |

## Verify

Run the public-release audit after capture:

```bash
cd web
npm run audit:public
```

Inspect every image for loading states, clipped dialogs, missing previews, secrets, and stale labels before committing it.
