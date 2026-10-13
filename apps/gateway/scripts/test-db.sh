#!/usr/bin/env bash
# Throwaway Postgres for the gateway integration tests (run inside WSL, where Docker lives).
#   bash apps/gateway/scripts/test-db.sh start   -> prints the TEST_DATABASE_URL to export on Windows
#   bash apps/gateway/scripts/test-db.sh stop
# Data lives on a tmpfs, so every start is a clean database and nothing is left on disk.
set -euo pipefail

NAME=urumi-gateway-test-pg
IMAGE=${PG_IMAGE:-postgres:18.6-alpine}
PORT=${PG_TEST_PORT:-55432}
# A test-only password for a container that holds no real data and is bound to localhost.
PASSWORD=gateway-test-only

case "${1:-start}" in
  start)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "already running"
    else
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" \
        -p "127.0.0.1:${PORT}:5432" --tmpfs /var/lib/postgresql "$IMAGE" >/dev/null
      for _ in $(seq 1 30); do
        if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
        sleep 1
      done
    fi
    echo "TEST_DATABASE_URL=postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres"
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 1
    ;;
esac
