set positional-arguments

# Run the required CI checks locally before you push. The steps live in
# scripts/local-ci.py; see docs/development/ci.md. Example: just ci --skip nextest-on
ci *args:
    python3 scripts/local-ci.py "$@"

# Offline check of AGENTS.md and the repo skills.
guidance:
    python3 -B -m unittest discover -s scripts -p test_agent_guidance.py -v
    python3 -B scripts/check-agent-guidance.py

# Opt in to the staged-change checks in .githooks/pre-commit.
hooks:
    git config core.hooksPath .githooks
