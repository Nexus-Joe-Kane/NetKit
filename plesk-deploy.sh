#!/usr/bin/env bash
#
# Plesk deployment script.
#
# Paste this into Plesk -> Git -> your repository -> "Deployment actions", or
# run it over SSH from the application root. It is safe to run repeatedly.
#
# Plesk runs deployment actions in a stripped environment: PATH is often empty,
# so even `dirname` is missing, and Plesk's own Node lives outside the standard
# directories. Everything below therefore resolves its own tools and never
# assumes anything is already on PATH.
set -euo pipefail

# ---- PATH ------------------------------------------------------------------
# Restore the standard directories first so coreutils (mkdir, touch, chmod)
# work. Anything Plesk did give us is kept, appended, so a custom toolchain in
# the environment still wins nothing but still works.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

# ---- Application root ------------------------------------------------------
# Two things make this fiddly. `dirname` is not guaranteed to exist, so the
# last path segment is stripped with parameter expansion. And when the script
# is piped in -- which is what Plesk's "Deployment actions" box does -- $0 is
# the shell (`/bin/bash`), not the script, so deriving a directory from it
# would land somewhere absurd like /bin.
#
# So identify the application root by what is in it rather than by trusting
# $0: the workspace root holds both package.json and server/package.json.
is_app_root() {
  [ -f "$1/package.json" ] && [ -f "$1/server/package.json" ]
}

app_root=""
# Plesk runs deployment actions from the application root, and someone running
# this over SSH is normally already there.
if is_app_root "$PWD"; then
  app_root="$PWD"
else
  # Called by path from somewhere else (`bash /var/www/app/plesk-deploy.sh`).
  script_dir="${0%/*}"
  if [ "$script_dir" != "$0" ] && is_app_root "$script_dir"; then
    app_root="$script_dir"
  fi
fi

if [ -z "$app_root" ]; then
  echo "!! Cannot find the application root." >&2
  echo "   Looked in $PWD and expected package.json alongside server/package.json." >&2
  echo "   Run this from the directory Plesk has as the document root's parent," >&2
  echo "   i.e. the checkout that contains package.json." >&2
  exit 1
fi
cd "$app_root"

# ---- Node ------------------------------------------------------------------
# The app needs Node 20 or newer (see "engines" in package.json). Plesk's
# default is frequently much older, and the version its UI selects is not
# always the one on PATH during a deployment action, so pick deliberately:
# take the newest Node >= 20 out of everywhere Plesk and nvm install them.
NODE_MIN_MAJOR=20

major_of() {
  # "v20.11.1" -> "20"; empty when the argument is not a version string.
  local v="${1#v}"
  v="${v%%.*}"
  case "$v" in
    '' | *[!0-9]*) return 1 ;;
    *) printf '%s' "$v" ;;
  esac
}

best_node=""
best_major=0
# Binaries that are present but cannot execute -- almost always a Node built
# for a newer glibc than this OS has. Recorded separately because "installed
# but unrunnable" needs a completely different fix from "not installed".
unrunnable=""

for candidate in \
  "$(command -v node 2>/dev/null || true)" \
  /opt/plesk/node/*/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node \
  /usr/local/n/versions/node/*/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  # Ask the binary itself rather than trusting the path: a directory named
  # "20" can hold something that will not start.
  if ! version="$("$candidate" -v 2>/dev/null)"; then
    unrunnable="${unrunnable}     $candidate
"
    continue
  fi
  candidate_major="$(major_of "$version" || true)"
  [ -n "$candidate_major" ] || continue
  if [ "$candidate_major" -gt "$best_major" ]; then
    best_major="$candidate_major"
    best_node="$candidate"
  fi
done

# One shared explanation, because both failures below can be caused by it.
report_unrunnable() {
  [ -n "$unrunnable" ] || return 0
  echo "" >&2
  echo "   These Node binaries are installed but will not run on this OS:" >&2
  printf '%s' "$unrunnable" >&2
  echo "   Run one directly to see why. A message naming GLIBC_2.28," >&2
  echo "   GLIBCXX_3.4.2x or CXXABI_1.3.x means the binary was built for a" >&2
  echo "   newer OS than this server: official Node 18+ builds need glibc" >&2
  echo "   2.28, and EL7-era systems ship 2.17. Check with 'ldd --version'." >&2
  echo "   The fix is a Node ${NODE_MIN_MAJOR} built for this OS -- ask your host for a" >&2
  echo "   Plesk Node package that matches it, or use the glibc-217 build" >&2
  echo "   from unofficial-builds.nodejs.org. Do not paste a generic" >&2
  echo "   linux-x64 tarball over it; that is what produces this error." >&2
}

if [ -z "$best_node" ]; then
  echo "!! No usable Node runtime found." >&2
  echo "   Looked on PATH, in /opt/plesk/node/*/bin, ~/.nvm and /usr/local/bin." >&2
  if [ -z "$unrunnable" ]; then
    echo "   In Plesk, enable the Node.js extension for this domain, then set" >&2
    echo "   the Node.js version to ${NODE_MIN_MAJOR} or newer." >&2
  fi
  report_unrunnable
  exit 1
fi

if [ "$best_major" -lt "$NODE_MIN_MAJOR" ]; then
  echo "!! The newest Node that actually runs here is $("$best_node" -v)" >&2
  echo "   at $best_node, and this application needs ${NODE_MIN_MAJOR} or newer." >&2
  echo "   Set it in Plesk -> Domains -> your domain -> Node.js -> Node.js version." >&2
  echo "   Installing under an older Node builds a tree the app cannot boot." >&2
  report_unrunnable
  exit 1
fi

# Put the chosen Node first so `npm` and any lifecycle script that shells out
# to `node` get this one rather than whatever Plesk had on PATH.
node_bin_dir="${best_node%/*}"
PATH="$node_bin_dir:$PATH"
export PATH

if ! command -v npm >/dev/null 2>&1; then
  echo "!! Found Node at $best_node but no npm beside it." >&2
  exit 1
fi

echo "==> Node $(node -v) ($best_node), npm $(npm -v)"

# ---- Dependencies ---------------------------------------------------------
# `npm ci` needs the lockfile; fall back to install if it is absent.
if [ -f package-lock.json ]; then
  echo "==> Installing dependencies (npm ci)"
  npm ci --no-audit --no-fund
else
  echo "==> Installing dependencies (npm install -- no lockfile found)"
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
echo "==> Touched tmp/restart.txt -- Passenger will reload on the next request"

echo ""
echo "Deployment complete."
echo "If this is a first install, check the application log for the generated"
echo "administrator password (or set ADMIN_PASSWORD before first start)."
