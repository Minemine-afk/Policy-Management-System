#!/bin/bash
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
pkill -f "./auth" || true; pkill -f "postgrest pgrst.conf" || true; sleep 1
rm -rf files
su postgres -c "psql -q -c 'drop database if exists e2e with (force)' -c 'create database e2e'"
su postgres -c "psql -q -d e2e -c 'create extension pgcrypto' -c 'create schema auth authorization supabase_auth_admin'"
(set -a; . ./gotrue.env; set +a; nohup ./auth > gotrue.log 2>&1 &)
until curl -s 127.0.0.1:9999/health >/dev/null; do sleep 1; done
R="$(cd "$HERE/../.." && pwd)"
for f in $HERE/prep.sql $R/supabase/migrations/*.sql $R/supabase/seed.sql; do su postgres -c "psql -v ON_ERROR_STOP=1 -q -d e2e -f $f" 2>&1 | grep -v NOTICE || true; done
nohup ./postgrest pgrst.conf > pgrst.log 2>&1 &
sleep 2; echo reset done
