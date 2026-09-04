#!/usr/bin/env bash
set -euo pipefail
if docker ps -a --format '{{.Names}}' | grep -qx keel-postgres; then
  echo "keel-postgres already exists"; exit 0
fi
PASS="$(openssl rand -hex 24)"
docker run -d --name keel-postgres \
  --restart unless-stopped \
  -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=keel \
  -e POSTGRES_PASSWORD="$PASS" \
  -e POSTGRES_DB=keel \
  -v keel-postgres-data:/var/lib/postgresql/data \
  postgres:16-alpine
cat > /etc/keel/db.env <<EOF
KEEL_DB_URL=postgres://keel:${PASS}@127.0.0.1:5433/keel
export KEEL_DB_URL KEEL_DB_TEST_URL
EOF
chmod 600 /etc/keel/db.env
echo "wrote /etc/keel/db.env"
