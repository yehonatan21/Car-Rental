#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu/Debian server to host the app with Docker + Caddy (automatic HTTPS).
# Run as root on the server:
#
#   curl -fsSL https://raw.githubusercontent.com/yehonatan21/car-rental/dev/scripts/server-setup.sh \
#     | bash -s -- --env dev --key "ssh-ed25519 AAAA… github-actions" [--domain dev.example.com]
#
#   --env      dev (image :dev, default) or prod (image :latest)
#   --key      public SSH key that GitHub Actions uses to deploy (the private half goes in DEPLOY_SSH_KEY)
#   --domain   public host name pointing at this server; default: <ip>.sslip.io (works without buying a domain)
#   --path     install directory (default /opt/car-rental)
#   --branch   branch to download the compose files from (default: dev)
set -euo pipefail

ENV_NAME=dev
PUBKEY=""
DOMAIN=""
DIR=/opt/car-rental
BRANCH=dev
REPO=yehonatan21/car-rental
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --key) PUBKEY="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --path) DIR="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo -i)." >&2; exit 1; }
[[ "$ENV_NAME" == dev || "$ENV_NAME" == prod ]] || { echo "--env must be dev or prod" >&2; exit 1; }
TAG=$([[ "$ENV_NAME" == dev ]] && echo dev || echo latest)

echo "==> Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Creating the 'deploy' user used by GitHub Actions"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
if [[ -n "$PUBKEY" ]]; then
  touch /home/deploy/.ssh/authorized_keys
  grep -qxF "$PUBKEY" /home/deploy/.ssh/authorized_keys || echo "$PUBKEY" >> /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
else
  echo "    (no --key given: add the deploy key to /home/deploy/.ssh/authorized_keys later)"
fi

echo "==> Firewall: allow SSH, HTTP, HTTPS"
if [[ -f /etc/iptables/rules.v4 ]] && grep -q 'REJECT' /etc/iptables/rules.v4; then
  # Oracle Cloud Ubuntu images ship iptables rules that reject everything but SSH (ufw is not used there).
  # Insert the ACCEPT rules just before the first REJECT rule.
  pos=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
    # shellcheck disable=SC2086
    iptables -C INPUT $rule -j ACCEPT 2>/dev/null || iptables -I INPUT "${pos:-1}" $rule -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null
  echo "    (Oracle Cloud: also open TCP 80/443 in the VCN security list, see docs/free-hosting.md)"
elif command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

if [[ -z "$DOMAIN" ]]; then
  IP=$(curl -fsS4 https://api.ipify.org)
  DOMAIN="${ENV_NAME}.${IP//./-}.sslip.io"
fi

echo "==> Preparing ${DIR}"
install -d -o deploy -g deploy "$DIR"
for f in docker-compose.prod.yml Caddyfile; do
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f}" -o "${DIR}/${f}"
done
if [[ ! -f "${DIR}/.env" ]]; then
  cat > "${DIR}/.env" <<EOF
# Car Rental – ${ENV_NAME} environment. Edit, then: docker compose -f docker-compose.prod.yml up -d
IMAGE=ghcr.io/${REPO}:${TAG}
DOMAIN=${DOMAIN}
BASE_URL=https://${DOMAIN}
APP_ENV=${ENV_NAME}
APP_NAME=הזמנת רכב$([[ "$ENV_NAME" == dev ]] && echo ' (פיתוח)')
MAIL_FROM=car-rental@${DOMAIN}
# Without SMTP settings e-mails are stored as files in the app-data volume (outbox/).
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
EOF
fi
chown deploy:deploy "$DIR"/*
chmod 600 "${DIR}/.env"

echo "==> Starting the app"
cd "$DIR"
if ! docker compose -f docker-compose.prod.yml pull; then
  echo
  echo "Could not pull the image. If the GitHub package is private, log in first:"
  echo "  docker login ghcr.io -u <github-user>     (password: a token with read:packages)"
  echo "then run: cd ${DIR} && docker compose -f docker-compose.prod.yml up -d"
  exit 1
fi
docker compose -f docker-compose.prod.yml up -d --no-build

cat <<EOF

Done. In a minute the app is at:  https://${DOMAIN}
(Caddy obtains the HTTPS certificate on the first request; ports 80 and 443 must be reachable.)

Create the first admin:
  cd ${DIR} && docker compose -f docker-compose.prod.yml exec app node scripts/create-admin.js --email you@example.com --password '<strong password>'

For GitHub Actions (environment "$([[ "$ENV_NAME" == dev ]] && echo development || echo production)"):
  DEPLOY_SSH_HOST         = $(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  DEPLOY_SSH_KNOWN_HOSTS  = output of: ssh-keyscan -H <that host>
  APP_URL (variable)      = https://${DOMAIN}
EOF
