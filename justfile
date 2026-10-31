set positional-arguments

# Run the required CI checks locally before you push. The steps live in
# scripts/local-ci.py; see docs/development/ci.md. Example: just ci --skip nextest-on
ci *args:
    python3 scripts/local-ci.py "$@"

# Fast offline validation of shared agent instructions and readiness links.
guidance:
    python3 -B -m unittest discover -s scripts -p test_agent_guidance.py -v
    python3 -B scripts/check-agent-guidance.py
