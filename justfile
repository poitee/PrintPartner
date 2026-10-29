set positional-arguments

# Run the required CI checks locally before you push. The steps live in
# scripts/local-ci.py; see docs/development/ci.md. Example: just ci --skip nextest-on
ci *args:
    python3 scripts/local-ci.py "$@"
