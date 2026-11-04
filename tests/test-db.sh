#!/bin/bash
# Runs the access-rule tests on a throwaway PostgreSQL database (no Docker needed).
# Usage: PGURL=postgres://user:password@127.0.0.1:5432/postgres bash tests/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGURL=${PGURL:-postgres:///postgres}
DB=dms_test_$$
psql "$PGURL" -qc "create database $DB"
trap 'psql "$PGURL" -qc "drop database $DB with (force)"' EXIT
URL="${PGURL%/*}/$DB"
for f in supabase/tests/stub_supabase.sql supabase/migrations/*.sql supabase/seed.sql supabase/tests/access_rules_test.sql; do
  if ! out=$(psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1); then echo "$out" | tail -5; echo "FAILED in $f"; exit 1; fi
  echo "$out" | grep -oE "ok.*|ALL ACCESS RULE TESTS PASSED" || true
done
