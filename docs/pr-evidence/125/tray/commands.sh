# Executed from /persist/worktrees/t3/PrintPartner/evidence-pr-125-tray-11f1d0b2
# Source and target branch left unchanged; only temporary build outputs/data written.
git rev-parse HEAD
git checkout --detach 11f1d0b2d2d4e9ca9acbd739c7bf3abc2e02a48c
# Confirm output == 11f1d0b2d2d4e9ca9acbd739c7bf3abc2e02a48c
sudo -n apt-get update
sudo -n apt-get install -y openbox tint2 xdotool python3-gi gir1.2-gtk-3.0 imagemagick
mkdir -p /tmp/pp125-tray-11f1d0b2
git show d77498c:docs/pr-evidence/125/tint2rc > /tmp/pp125-tray-11f1d0b2/tint2rc
npm --prefix web ci
VITE_PRINT_PARTNER_DESKTOP=1 npm --prefix web run build
python3 rust/scripts/stage-desktop.py --web web --node /opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node --output /tmp/pp125-tray-11f1d0b2/runtime --commit 11f1d0b2d2d4e9ca9acbd739c7bf3abc2e02a48c
PP_DESKTOP_RELEASE_MANIFEST=/tmp/pp125-tray-11f1d0b2/runtime/bundle-manifest.json cargo build --manifest-path rust/Cargo.toml --locked -p pp-desktop
Xvfb :125 -screen 0 1440x1000x24 -nolisten tcp > /tmp/pp125-tray-11f1d0b2/xvfb.log 2>&1 &
echo $! > /tmp/pp125-tray-11f1d0b2/xvfb.pid
DISPLAY=:125 PP_EVIDENCE_REPO="$PWD" dbus-run-session -- python3 /tmp/pp125-tray-11f1d0b2/capture-tray.py
kill "$(cat /tmp/pp125-tray-11f1d0b2/xvfb.pid)"
