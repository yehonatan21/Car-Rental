#!/usr/bin/env bash
# Deploys $IMAGE to the environment this job runs for. Two ways, configured per GitHub environment
# (Settings → Environments → development / production):
#
#  1. Your own server over SSH (see docs/dev-environment.md):
#       secrets   DEPLOY_SSH_HOST, DEPLOY_SSH_KEY (private key), DEPLOY_SSH_KNOWN_HOSTS (optional, recommended)
#       variables DEPLOY_SSH_USER (default "deploy"), DEPLOY_SSH_PORT (default 22), DEPLOY_PATH (default /opt/car-rental)
#     Copies docker-compose.prod.yml + Caddyfile, pulls the image and restarts the stack.
#
#  2. A hosting platform's deploy hook (Render, Railway, Coolify, …):
#       secret    DEPLOY_HOOK_URL
#
# With neither configured the image is published but nothing is deployed.
set -euo pipefail

if [[ -n "${DEPLOY_SSH_HOST:-}" ]]; then
  : "${DEPLOY_SSH_KEY:?DEPLOY_SSH_KEY secret is required for SSH deployment}"
  user="${DEPLOY_SSH_USER:-deploy}"
  port="${DEPLOY_SSH_PORT:-22}"
  dir="${DEPLOY_PATH:-/opt/car-rental}"
  target="${user}@${DEPLOY_SSH_HOST}"

  key="$(mktemp)"
  trap 'rm -f "$key"' EXIT
  printf '%s\n' "$DEPLOY_SSH_KEY" > "$key"
  chmod 600 "$key"
  mkdir -p ~/.ssh
  if [[ -n "${DEPLOY_SSH_KNOWN_HOSTS:-}" ]]; then
    printf '%s\n' "$DEPLOY_SSH_KNOWN_HOSTS" >> ~/.ssh/known_hosts
  else
    echo "::warning::DEPLOY_SSH_KNOWN_HOSTS is not set; trusting the server's current host key (ssh-keyscan)."
    ssh-keyscan -p "$port" -H "$DEPLOY_SSH_HOST" >> ~/.ssh/known_hosts 2>/dev/null
  fi
  ssh_opts=(-i "$key" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=yes)

  echo "Deploying ${IMAGE} to ${target}:${dir}"
  scp -i "$key" -P "$port" -o BatchMode=yes -o StrictHostKeyChecking=yes docker-compose.prod.yml Caddyfile "${target}:${dir}/"
  ssh "${ssh_opts[@]}" "$target" bash -s -- "$dir" "$IMAGE" <<'REMOTE'
set -euo pipefail
cd "$1"
export IMAGE="$2"
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d --no-build --remove-orphans
docker image prune -f > /dev/null
docker compose -f docker-compose.prod.yml ps
REMOTE
  echo "Deployed."
  exit 0
fi

if [[ -n "${DEPLOY_HOOK_URL:-}" ]]; then
  echo "Deploying ${IMAGE} via deploy hook"
  curl -fsS --retry 3 --retry-delay 5 -X POST "${DEPLOY_HOOK_URL}" \
    -H 'Content-Type: application/json' \
    -d "{\"image\":\"${IMAGE}\",\"sha\":\"${GITHUB_SHA}\"}" > /dev/null
  echo "Deploy hook accepted."
  exit 0
fi

echo "::notice::No deployment configured for this environment (DEPLOY_SSH_HOST or DEPLOY_HOOK_URL); image ${IMAGE} was published but not deployed."
