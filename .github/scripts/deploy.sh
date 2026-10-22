#!/usr/bin/env bash
# Triggers a redeploy of $IMAGE through the hosting platform's deploy hook
# (Render, Railway, Coolify, Portainer, a webhook on your own server, …).
# The hook URL is a per-environment secret: Settings → Environments → <env> → DEPLOY_HOOK_URL.
set -euo pipefail

if [[ -z "${DEPLOY_HOOK_URL:-}" ]]; then
  echo "::notice::DEPLOY_HOOK_URL is not set for this environment; image ${IMAGE} was published but not deployed."
  exit 0
fi

echo "Deploying ${IMAGE}"
curl -fsS --retry 3 --retry-delay 5 -X POST "${DEPLOY_HOOK_URL}" \
  -H 'Content-Type: application/json' \
  -d "{\"image\":\"${IMAGE}\",\"sha\":\"${GITHUB_SHA}\"}" > /dev/null
echo "Deploy hook accepted."
