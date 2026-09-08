#!/usr/bin/env bash
#
# Reports what this server can actually run, so a failed deploy can be
# diagnosed without guessing. Read-only: it changes nothing.
#
#   bash plesk-doctor.sh
#
# Written to survive the same stripped environment Plesk gives deployment
# actions, so it avoids `dirname` and sets its own PATH.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

echo "=============================================="
echo " NetKit environment report"
echo "=============================================="
echo ""

echo "-- Operating system --------------------------"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "  ${PRETTY_NAME:-${NAME:-unknown}}"
else
  echo "  /etc/os-release not readable"
fi
echo "  kernel: $(uname -r 2>/dev/null || echo unknown)"
echo "  arch:   $(uname -m 2>/dev/null || echo unknown)"
echo ""

echo "-- glibc -------------------------------------"
# This is the number that decides whether official Node 18+ can run at all:
# those builds require 2.28.
glibc_line="$(ldd --version 2>/dev/null | head -1 || true)"
if [ -n "$glibc_line" ]; then
  echo "  $glibc_line"
  glibc_ver="${glibc_line##* }"
  glibc_major="${glibc_ver%%.*}"
  glibc_minor="${glibc_ver#*.}"
  glibc_minor="${glibc_minor%%.*}"
  case "$glibc_major.$glibc_minor" in
    '' | *[!0-9.]*) ;;
    *)
      if [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 28 ]; then
        echo ""
        echo "  !! glibc is older than 2.28."
        echo "     Official Node 18, 20 and 22 builds will NOT start on this"
        echo "     server -- that is the source of any GLIBC_2.28 /"
        echo "     GLIBCXX_3.4.2x / CXXABI_1.3.x error you have seen."
        echo "     You need a Node built for this OS. Either ask your host to"
        echo "     install a matching Plesk Node package, or use the"
        echo "     'glibc-217' variant from unofficial-builds.nodejs.org."
      else
        echo "  glibc is new enough for official Node 20 builds."
      fi
      ;;
  esac
else
  echo "  could not determine (ldd unavailable)"
fi
echo ""

echo "-- Node runtimes found -----------------------"
found_any=0
seen=""
for candidate in \
  "$(command -v node 2>/dev/null || true)" \
  /opt/plesk/node/*/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node \
  /usr/local/n/versions/node/*/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  # Do not report the same binary twice when it is on PATH as well.
  case "$seen" in *"|$candidate|"*) continue ;; esac
  seen="$seen|$candidate|"
  found_any=1
  if version="$("$candidate" -v 2>/dev/null)"; then
    npm_dir="${candidate%/*}"
    if [ -x "$npm_dir/npm" ]; then
      npm_version="$("$npm_dir/npm" -v 2>/dev/null || echo '(npm failed)')"
    else
      npm_version="(no npm beside it)"
    fi
    echo "  RUNS      $version  $candidate   npm $npm_version"
  else
    echo "  BROKEN    $candidate"
    "$candidate" -v 2>&1 | head -2 | sed 's/^/              /'
  fi
done
[ "$found_any" -eq 1 ] || echo "  none found"
echo ""

echo "-- Application ------------------------------"
echo "  cwd: $PWD"
for f in package.json server/package.json app.js; do
  [ -f "$f" ] && echo "  present: $f" || echo "  MISSING: $f"
done
if [ -d node_modules ]; then
  echo "  node_modules: present"
else
  echo "  node_modules: absent (deploy has not installed yet)"
fi
if [ -d public ]; then
  echo "  public/: present (web build output)"
else
  echo "  public/: absent -- the SPA has not been built"
fi
echo ""

echo "-- Data directory ---------------------------"
DATA_DIR="${DATA_DIR:-data}"
if [ -d "$DATA_DIR" ]; then
  echo "  $DATA_DIR exists, mode $(stat -c '%a' "$DATA_DIR" 2>/dev/null || echo '?')"
else
  echo "  $DATA_DIR does not exist yet (the deploy script creates it)"
fi
echo ""
echo "Report ends. Nothing was changed."
