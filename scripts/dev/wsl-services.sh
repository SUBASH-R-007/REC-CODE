#!/usr/bin/env bash
# Install the local development services natively in a WSL2 / Debian-family
# Linux box: PostgreSQL 17 (PGDG), Redis 7, Node 22 (official tarball).
# For machines where Docker is available, compose.yaml at the repo root runs
# the same services in containers instead.
#
# Idempotent. Run as root:  sudo bash scripts/dev/wsl-services.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

NODE_VERSION="22.17.1"

apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release rsync >/dev/null

# PostgreSQL 17 from the PostgreSQL Global Development Group repository.
if ! command -v /usr/lib/postgresql/17/bin/postgres >/dev/null 2>&1; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-17 postgresql-contrib >/dev/null
fi

# Redis 7 (Ubuntu 24.04 ships 7.0.x). AOF everysec, as in production.
apt-get install -y -qq redis-server >/dev/null
sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
sed -i 's/^# appendfsync everysec/appendfsync everysec/' /etc/redis/redis.conf
systemctl enable --now redis-server >/dev/null
systemctl restart redis-server

# Postgres: local dev role + databases (never the LMS database).
systemctl enable --now postgresql >/dev/null
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recx') THEN
    CREATE ROLE recx LOGIN PASSWORD 'recx-dev-only' CREATEDB;
  END IF;
END $$;
SQL
for db in recx recx_test; do
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    sudo -u postgres createdb -O recx "$db"
  fi
done
# Listen on all interfaces so the Windows side can reach it via localhost
# forwarding; password auth only, dev credentials only.
PGCONF=/etc/postgresql/17/main
sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" "$PGCONF/postgresql.conf"
# Port 5433: a Windows-native Postgres (e.g. the LMS's) commonly owns 5432,
# and WSL's localhost forwarding would otherwise lose the race for it.
sed -i "s/^#\?port = .*/port = 5433/" "$PGCONF/postgresql.conf"
grep -q "recx-dev" "$PGCONF/pg_hba.conf" || \
  echo "host all recx 0.0.0.0/0 scram-sha-256 # recx-dev" >> "$PGCONF/pg_hba.conf"
systemctl restart postgresql

# Node 22 (official tarball, checksum-verified) for Linux-native builds.
if ! /opt/node22/bin/node --version 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  curl -fsSL -o "$tmp/node.tar.xz" "$base/node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  expected="$(grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  echo "${expected}  $tmp/node.tar.xz" | sha256sum -c - >/dev/null
  rm -rf /opt/node22 && mkdir -p /opt/node22
  tar -xJf "$tmp/node.tar.xz" -C /opt/node22 --strip-components=1
  rm -rf "$tmp"
fi
ln -sf /opt/node22/bin/node /usr/local/bin/node
ln -sf /opt/node22/bin/npm /usr/local/bin/npm
ln -sf /opt/node22/bin/npx /usr/local/bin/npx
ln -sf /opt/node22/bin/corepack /usr/local/bin/corepack
/usr/local/bin/corepack enable --install-directory /usr/local/bin pnpm >/dev/null 2>&1 || true

echo "postgres: $(sudo -u postgres psql -tAc 'select version()' | cut -d' ' -f1-2)"
echo "redis:    $(redis-server --version | cut -d' ' -f3)"
echo "node:     $(/usr/local/bin/node --version)"
