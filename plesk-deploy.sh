#!/usr/bin/env bash
#
# Plesk deployment script.
#
# Paste this into Plesk → Git → your repository → "Deployment actions", or run
# it over SSH from the application root. It is safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Node $(node -v), npm $(npm -v)"

# ---- Dependencies ---------------------------------------------------------
# `npm ci` needs the lockfile; fall back to install if it is absent.
if [ -f package-lock.json ]; then
  echo "==> Installing dependencies (npm ci)"
  npm ci --no-audit --no-fund
else
  echo "==> Installing dependencies (npm install — no lockfile found)"
  npm install --no-audit --no-fund
fi

# ---- Build ----------------------------------------------------------------
echo "==> Building shared, server and web"
npm run build

# ---- Data directory ------------------------------------------------------
# Users, settings and the audit log live here. It must survive deploys, so it
# is gitignored and only created if missing.
DATA_DIR="${DATA_DIR:-data}"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
echo "==> Data directory ready at $DATA_DIR"

# ---- Restart -------------------------------------------------------------
# Passenger restarts when this file's mtime changes.
mkdir -p tmp
touch tmp/restart.txt
echo "==> Touched tmp/restart.txt — Passenger will reload on the next request"

echo ""
echo "Deployment complete."
echo "If this is a first install, check the application log for the generated"
echo "administrator password (or set ADMIN_PASSWORD before first start)."
