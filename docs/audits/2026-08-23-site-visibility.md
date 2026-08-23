# Site visibility and usability audit

Date: 2026-08-23

## Scope

This audit covers route visibility in `web/apps/web/src/App.tsx`, shared desktop and mobile navigation, authentication recovery, and the loading and error states listed under verified fixes. It compares the current site with the accepted workflow in the August 19 Superpowers plans.

## Verified fixes

- **Source Library** is visible below **Builds** in desktop navigation and the mobile utility menu.
- Global Production is named **All Production** to distinguish it from a Build's **Production** stage.
- Opening **All Production** no longer redirects to the selected Build's Production page.
- The mobile utility menu marks the current destination.
- Unknown authenticated URLs show a Page not found screen with links to **Builds** and **Help**.
- Authentication return links preserve the path, query, and fragment.
- Forgot-password and reset-password forms submit with Enter.
- Library source menus include the source name in their accessible name.
- Library Platform, Category, and repository-list fields have programmatic labels.
- Library and Printers announce loading and failure states.
- Share import links call the global destination **Source Library**, not Sources.

## Routes

| Route | Owner | Visible entry | Audit result |
| --- | --- | --- | --- |
| `/builds` | Global Builds | Desktop and mobile utility navigation | Verified |
| `/library` | Global Source Library | Desktop and mobile utility navigation | Fixed and verified |
| `/production` | All Production | Desktop and mobile utility navigation | Fixed and verified |
| `/printers` | Printers | Desktop and mobile utility navigation | Verified |
| `/settings` | Settings | Desktop and mobile utility navigation | Verified |
| `/help` | Help | Desktop and mobile utility navigation | Verified |
| `/sources` | Build Sources | Build workflow navigation | Verified |
| `/plan` | Build Plan | Build workflow navigation | Verified |
| `/progress` | Build Checkoff | Build workflow navigation | Verified |
| `/export` | Build Production | Build workflow navigation | Verified, transitional URL |
| unknown authenticated path | Recovery | Direct URL or stale bookmark | Fixed and verified |

## Accepted work that is not implemented

These items need product and data-model work. This audit did not add placeholder controls for behavior that does not exist.

- Source Library Inbox, Following, durable update observations, revision summaries, and **Review in Plan**.
- The accepted rule that monitoring may fetch a candidate revision but never apply it automatically. Settings still exposes source auto-sync controls.
- Global Production **Live**, **Queue**, and **History** views.
- Printer creation, detail editing, connection testing, archive, and history inside Printers. Some management still routes through Settings.
- The accepted Settings information architecture and removal or relocation of legacy controls.
- A Thangs manual source adapter.
- Canonical Build routes that replace the transitional `/export`, `/parts`, and related aliases.
- A real browser end-to-end journey through Build creation, Sources, Plan, Checkoff, Production, printer work, and verification.

## Verification

- Web unit and component tests: 126 files, 515 tests passed.
- TypeScript: passed.
- ESLint: passed.
- Public release checks: 10 tests passed.
- Workflow smoke tests: 9 tests passed.
- Production build: passed.
- Browser checks: passed with Playwright Chromium using the cached runtime libraries through `LD_LIBRARY_PATH` and the cached font tree through `FONTCONFIG_SYSROOT` and `FONTCONFIG_FILE`.
