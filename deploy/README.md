# ⚠️ Decommissioned deployment — do not run on the lab box

This directory is the **Lane-B (fluxology.ca) deployment**, kept for
reference and for the runbook's still-valid Windows-agent sections. Its
compose expects the `fluxology-edge` network and the business VPS's Caddy,
neither of which exists on the lab box — running it there builds an unused
`deploy-mcp-gateway:latest` image and then fails on the missing network
(observed 2026-09-01).

**The live deployment of this gateway is the `fluxlab-bridge` stack in the
FluxLab repo**: on the lab VPS, from the FluxLab checkout root, run
`make bridge` (= `vps/bridge/deploy.sh`, stages env → src → build → up →
migrate → verify). That script maintains the mcp-ebay checkout it builds
from (`${BRIDGE_SRC}`), so updating the gateway is one command there —
never `docker compose` against this directory.

Redeploy + claude.ai reconnect procedure:
`docs/routines/CONNECTOR-APPROVALS.md` in ethanbissbort/fluxlab-boards.
