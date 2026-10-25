#!/usr/bin/env bash
# Waits for the deployed app to report healthy. APP_URL is an environment variable
# (Settings → Environments → <env> → Variables), e.g. https://dev.car.example.org
set -euo pipefail

if [[ -z "${APP_URL:-}" ]]; then
  echo "::notice::APP_URL is not set for this environment; skipping post-deploy health check."
  exit 0
fi

for i in $(seq 1 30); do
  if body=$(curl -fsS "${APP_URL%/}/healthz"); then
    echo "Healthy: ${body}"
    exit 0
  fi
  echo "Waiting for ${APP_URL} (attempt ${i}/30)…"
  sleep 10
done
echo "::error::${APP_URL}/healthz did not become healthy in time"
exit 1
