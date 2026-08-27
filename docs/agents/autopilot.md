# Autopilot

Take an open Print Partner pull request to merge-ready: conflicts resolved, review threads triaged, required CI green.

Agents should follow [`.agents/skills/autopilot/SKILL.md`](../../.agents/skills/autopilot/SKILL.md). Invoke it with `/autopilot` in Cursor, or say to land the current PR.

## What it does

Every pass starts by reading compact PR state:

```bash
node .agents/skills/autopilot/scripts/pr-state.mjs
```

The script prints JSON with a `nextAction` of `conflicts`, `comments`, `ci`, `watch-ci`, `ready`, or `no-pr`. Autopilot works those blockers in that order and stops when `nextAction` is `ready`.

It does not merge, enable auto-merge, or mark a draft ready.

## Cursor Automation

Cursor Automations are configured in the product UI, not committed as YAML (`.cursor/` is local-only in this repo). Copy the prompt and trigger list from [the automation reference](../../.agents/skills/autopilot/references/cursor-automation.md) into [cursor.com/automations](https://cursor.com/automations).

## Verify the helper

```bash
node --test scripts/autopilot-pr-state.test.mjs
```
