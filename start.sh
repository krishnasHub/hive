#!/usr/bin/env sh
# Runs Hive from source on macOS and Linux (and Git Bash on Windows).
#   ./start.sh          build and start Hive
#   ./start.sh --dev    start with hot reload while you work on Hive
# Anything else is passed to the app, e.g. ./start.sh --hidden starts in the tray.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Hive needs Node.js 20 or newer: https://nodejs.org" >&2
  exit 1
fi
if ! node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"; then
  echo "Hive needs Node.js 20 or newer (found $(node -v)): https://nodejs.org" >&2
  exit 1
fi

# First run, or the lockfile changed since the last install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ "$1" = "--dev" ]; then
  exec npm run dev
fi

cd apps/desktop
echo "Building Hive..."
npx electron-vite build
exec npx electron . "$@"
