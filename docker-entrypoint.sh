#!/bin/sh
# Fix /data ownership for named volumes (often root-owned on first mount),
# then drop to ppuser and run the app under dumb-init.
set -eu

run_as_ppuser() {
  if command -v gosu >/dev/null 2>&1; then
    exec gosu ppuser dumb-init -- "$@"
  fi
  exec su-exec ppuser dumb-init -- "$@"
}

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R ppuser:ppuser /data
  run_as_ppuser "$@"
fi

# Already non-root (e.g. compose user override): skip chown
exec dumb-init -- "$@"
