#!/usr/bin/env bash
# Bring up a throwaway local Postgres cluster without Docker.
#
# Use this when no Docker daemon is available (CI runners and some dev
# containers). If you have Docker, `docker compose up -d db` is equivalent and
# gives you the same connection string.
#
#   ./scripts/dev-pg.sh up     start cluster, create role + databases
#   ./scripts/dev-pg.sh down   stop cluster
#   ./scripts/dev-pg.sh nuke   stop cluster and delete all data
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Override with SKEDDY_PGDATA when the repo lives somewhere the postgres user
# cannot traverse (common under /home in containers).
PGDATA="${SKEDDY_PGDATA:-$ROOT/.pgdata}"
PORT="${PGPORT:-5432}"
SOCKET_DIR="$PGDATA/sockets"
LOGFILE="$PGDATA/postgres.log"

# Locate server binaries: they are not on PATH in Debian/Ubuntu images.
if command -v pg_ctl >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v pg_ctl)")"
else
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "error: could not find postgres server binaries (pg_ctl)." >&2
  echo "       install postgresql-16, or use 'docker compose up -d db' instead." >&2
  exit 1
fi

# Postgres refuses to run as root. When we are root (common in containers), do
# the cluster work as the `postgres` system user instead.
if [ "$(id -u)" -eq 0 ]; then
  if ! id postgres >/dev/null 2>&1; then
    echo "error: running as root and there is no 'postgres' user to drop to." >&2
    exit 1
  fi
  as_pg() { su postgres -s /bin/bash -c "$1"; }
  OWNER=postgres
else
  as_pg() { bash -c "$1"; }
  OWNER="$(id -un)"
fi

start() {
  mkdir -p "$PGDATA"
  chown -R "$OWNER" "$PGDATA" 2>/dev/null || true

  if [ ! -d "$PGDATA/base" ]; then
    echo "==> initdb $PGDATA"
    as_pg "'$PGBIN/initdb' -D '$PGDATA' -U postgres --auth=trust --encoding=UTF8" >/dev/null
  fi
  mkdir -p "$SOCKET_DIR"
  chown -R "$OWNER" "$PGDATA" 2>/dev/null || true

  if as_pg "'$PGBIN/pg_ctl' -D '$PGDATA' status" >/dev/null 2>&1; then
    echo "==> already running on port $PORT"
  else
    echo "==> starting postgres on port $PORT"
    as_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -l '$LOGFILE' -o '-p $PORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1' -w start"
  fi

  # Role and databases are created idempotently: the `if not exists` dance is
  # done in SQL because CREATE ROLE/DATABASE have no IF NOT EXISTS form.
  psql_super() { "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

  psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname='skeddy'" | grep -q 1 \
    || psql_super -c "CREATE ROLE skeddy LOGIN PASSWORD 'skeddy' SUPERUSER"

  for db in skeddygoblin skeddygoblin_test; do
    psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || psql_super -c "CREATE DATABASE $db OWNER skeddy"
  done

  echo "==> ready"
  echo "    DATABASE_URL=postgres://skeddy:skeddy@127.0.0.1:$PORT/skeddygoblin"
  echo "    DATABASE_URL_TEST=postgres://skeddy:skeddy@127.0.0.1:$PORT/skeddygoblin_test"
}

case "${1:-up}" in
  up) start ;;
  down) as_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -m fast -w stop" || true ;;
  nuke)
    as_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -m immediate -w stop" 2>/dev/null || true
    rm -rf "$PGDATA"
    echo "==> removed $PGDATA"
    ;;
  *)
    echo "usage: $0 {up|down|nuke}" >&2
    exit 2
    ;;
esac
