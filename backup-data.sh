#!/usr/bin/env bash
#
# Backs up NetKit's data directory.
#
# `DATA_DIR` holds the only state that cannot be rebuilt from Git: the user
# accounts, the settings (including the ordering switch and its cap), the
# append-only audit log, the per-user daily counters and the recent-lookup
# lists. Everything else in the application is a build artefact.
#
# Run it from cron, nightly:
#
#   0 2 * * * /var/www/vhosts/<domain>/httpdocs/backup-data.sh >> /var/log/netkit-backup.log 2>&1
#
# Or add it to the Plesk scheduled tasks list. Point BACKUP_DIR somewhere the
# Plesk backup set already collects, so the archives leave the machine.
set -euo pipefail

cd "$(dirname "$0")"

# Read DATA_DIR from .env if it is set there, so the backup and the app can
# never disagree about which directory matters. A shell-level DATA_DIR wins.
if [ -z "${DATA_DIR:-}" ] && [ -f .env ]; then
  DATA_DIR="$(grep -E '^DATA_DIR=' .env | tail -n1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
fi
DATA_DIR="${DATA_DIR:-data}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
# Two weeks is enough to notice a bad change and still roll back, without the
# archives becoming their own storage problem.
KEEP_DAYS="${KEEP_DAYS:-14}"

if [ ! -d "$DATA_DIR" ]; then
  echo "!! DATA_DIR does not exist: $DATA_DIR" >&2
  echo "   Nothing was backed up. Check DATA_DIR in .env." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
# Restrictive from the start: the archive contains password hashes and the
# audit log, so it must never be world-readable, even for a moment.
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/netkit-data-$STAMP.tar.gz"

echo "==> Backing up $DATA_DIR"
# Written to a temporary name and moved into place, so a backup interrupted
# half-way never looks like a complete one.
tar -czf "$ARCHIVE.partial" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
mv "$ARCHIVE.partial" "$ARCHIVE"
chmod 600 "$ARCHIVE"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "==> Wrote $ARCHIVE ($SIZE)"

# ---- Verify --------------------------------------------------------------
# A backup nobody has read is a hope, not a backup. Listing it is cheap and
# catches a truncated or unreadable archive immediately.
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  echo "!! The archive is not readable — removing it rather than keeping a broken backup." >&2
  rm -f "$ARCHIVE"
  exit 1
fi

if ! tar -tzf "$ARCHIVE" | grep -q 'users.json'; then
  echo "!! Warning: users.json is not in the archive." >&2
  echo "   That is expected only on a brand-new install with no accounts yet." >&2
fi

# ---- Prune ---------------------------------------------------------------
echo "==> Removing archives older than $KEEP_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -name 'netkit-data-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -print -delete

COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'netkit-data-*.tar.gz' -type f | wc -l | tr -d ' ')"
echo "==> Done. $COUNT archive(s) held in $BACKUP_DIR"
echo
echo "To restore: stop the app, then"
echo "  tar -xzf $ARCHIVE -C $(dirname "$DATA_DIR")"
echo "and start it again. The audit log is append-only, so a restore rolls it"
echo "back to the backup point — note the gap if anyone asks."
