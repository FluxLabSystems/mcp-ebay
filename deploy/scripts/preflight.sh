#!/usr/bin/env bash
# Deployment preflight — SDD v0.5 §23.1. Verifies the pre-existing edge
# before `docker compose up`: the external network exists, fluxology-caddy
# is attached to it, and the compose file validates.
set -euo pipefail

cd "$(dirname "$0")/.."

docker network inspect fluxology-edge >/dev/null
docker inspect -f '{{json .NetworkSettings.Networks}}' fluxology-caddy \
  | grep -q 'fluxology-edge'
docker compose config >/dev/null
echo "Preflight OK: external edge exists and fluxology-caddy is attached."
