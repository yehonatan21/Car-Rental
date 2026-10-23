# Internet-accessible dev environment

A permanent dev environment on a small cloud server, reachable at an `https://` address from anywhere,
updated automatically on every push to the `dev` branch.

```
push to dev ──► GitHub Actions: lint + tests ──► build image ghcr.io/yehonatan21/car-rental:dev
                                              └─► SSH to the server ──► docker compose pull + up
                                                                          │
browser ──► https://dev.<your-domain> ──► Caddy (Let's Encrypt HTTPS) ──► app container ──► /data volume
```

> **Just need a quick, temporary link to your PC?** Run the app locally and use `npm run tunnel`
> (Cloudflare quick tunnel), as described in the README. The rest of this guide is for an always-on environment.

## What you need

- A Linux server (VPS) with a public IP: **Ubuntu 24.04**, 1 vCPU / 1 GB RAM is plenty.
  Any provider works: Hetzner (CX22, ~€4/month), DigitalOcean ($6/month), Linode, Vultr, AWS Lightsail, or the Oracle Cloud free tier.
- Optional: a domain name. Without one, the setup script uses a free `sslip.io` address
  (e.g. `dev.203-0-113-10.sslip.io`), which still gets a real HTTPS certificate.

## Step 1: Create the server

1. At your provider, create an **Ubuntu 24.04** server and add your own SSH key (or note the root password).
2. Note its **public IP address**, e.g. `203.0.113.10`.
3. If the provider has its own firewall (Hetzner Cloud Firewall, AWS security group, …), allow inbound **TCP 22, 80, 443** and **UDP 443**.

## Step 2 (optional): Point a domain at it

At your DNS provider, add an **A record**: `dev.example.com → 203.0.113.10`. Skip this step to use the free `sslip.io` address.

## Step 3: Create the deploy key for GitHub Actions

On your PC (PowerShell, macOS or Linux terminal):

```bash
ssh-keygen -t ed25519 -C "github-actions-car-rental-dev" -f car-rental-dev-deploy -N ""
```

This creates two files:
- `car-rental-dev-deploy.pub`: the **public** key, which goes on the server (step 4).
- `car-rental-dev-deploy`: the **private** key, which goes into GitHub (step 6). Never share or commit it.

## Step 4: Set up the server (one command)

Connect to the server (`ssh root@203.0.113.10`) and run, replacing the key with the contents of `car-rental-dev-deploy.pub`:

```bash
curl -fsSL https://raw.githubusercontent.com/yehonatan21/car-rental/dev/scripts/server-setup.sh \
  | bash -s -- --env dev --key "ssh-ed25519 AAAA...your-public-key... github-actions-car-rental-dev"
```

To use your own domain from step 2, add `--domain dev.example.com`.

The script:
- installs Docker,
- creates a `deploy` user that may only use Docker, authorized with your deploy key,
- enables the firewall (SSH, HTTP, HTTPS),
- downloads `docker-compose.prod.yml` + `Caddyfile` into `/opt/car-rental` and writes `/opt/car-rental/.env` (image `:dev`, domain, `BASE_URL`),
- starts Caddy and the app, and prints the address and the values you need for GitHub.

After a minute the app answers at the printed address, e.g. **https://dev.203-0-113-10.sslip.io**.
Caddy obtains the HTTPS certificate on the first request.

## Step 5: Create the admin account

Still on the server:

```bash
cd /opt/car-rental
docker compose -f docker-compose.prod.yml exec app \
  node scripts/create-admin.js --email you@example.com --password 'a-strong-password'
```

The server environment starts **empty**: there are no demo users, so the public `Password1` accounts don't exist there.
Log in at `https://<your-address>/login`; you land on the admin dashboard.

## Step 6: Connect GitHub Actions (automatic deploys)

In GitHub: **yehonatan21/car-rental → Settings → Environments → `development`** (create it if it is missing).

**Environment secrets:**

| Name | Value |
|---|---|
| `DEPLOY_SSH_HOST` | the server IP, e.g. `203.0.113.10` |
| `DEPLOY_SSH_KEY` | full contents of the private key file `car-rental-dev-deploy`, including the `-----BEGIN…` and `-----END…` lines |
| `DEPLOY_SSH_KNOWN_HOSTS` | output of `ssh-keyscan -H 203.0.113.10` (run on your PC). Pins the server's identity. |

**Environment variables:**

| Name | Value |
|---|---|
| `APP_URL` | the app address, e.g. `https://dev.203-0-113-10.sslip.io`. Used for the post-deploy health check and shown on the run. |
| `DEPLOY_SSH_USER` | optional, default `deploy` |
| `DEPLOY_SSH_PORT` | optional, default `22` |
| `DEPLOY_PATH` | optional, default `/opt/car-rental` |

Optionally, under **Deployment branches and tags**, choose **Selected branches** → `dev`, so only `dev` can deploy here.

## Step 7: Deploy

Push anything to `dev` (or re-run the latest workflow under **Actions → CI/CD → Re-run all jobs**). The pipeline now:

1. lints and runs the tests,
2. builds and publishes `ghcr.io/yehonatan21/car-rental:dev`,
3. **Deploy → development**: copies the compose files to the server over SSH, pulls the new image and restarts the app,
4. waits until `https://<APP_URL>/healthz` reports healthy.

The run page shows the environment URL. Data (database, license files) lives in the `app-data` Docker volume and survives deploys.

## Day-to-day

| Task | Command (on the server, in `/opt/car-rental`) |
|---|---|
| Status | `docker compose -f docker-compose.prod.yml ps` |
| App logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| Caddy / certificate logs | `docker compose -f docker-compose.prod.yml logs -f caddy` |
| Restart | `docker compose -f docker-compose.prod.yml restart app` |
| Change settings (`.env`) | edit `.env`, then `docker compose -f docker-compose.prod.yml up -d` |
| Backup | `docker run --rm -v car-rental_app-data:/data -v $PWD:/backup alpine tar czf /backup/backup-$(date +%F).tgz -C /data .` |
| E-mails without SMTP | `docker compose -f docker-compose.prod.yml exec app ls /data/outbox` |

To send real e-mail, fill in the `SMTP_*` lines in `.env` (any SMTP provider, e.g. Brevo, Mailgun, SendGrid or Gmail with an app password) and run `up -d`.

## A production environment later

Repeat the same steps on a second server with `--env prod` (image `:latest`, deployed from `main`), and put the
secrets/variables in the GitHub environment **`production`**. Add **Required reviewers** to that environment so every
production deploy waits for a manual approval.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser can't connect | Ports 80/443 closed: check the provider's firewall, and `ufw status` on the server. |
| Certificate error / Caddy logs show ACME failures | The domain doesn't point at the server yet (DNS can take minutes), or port 80 is blocked. |
| Deploy job: `Permission denied (publickey)` | `DEPLOY_SSH_KEY` doesn't match the key in `/home/deploy/.ssh/authorized_keys`, or it is missing the BEGIN/END lines. |
| Deploy job: `Host key verification failed` | `DEPLOY_SSH_KNOWN_HOSTS` is outdated (server rebuilt). Run `ssh-keyscan -H <ip>` again and update it. |
| Deploy job: `permission denied … docker.sock` | The `deploy` user isn't in the `docker` group: `usermod -aG docker deploy`. |
| Health check times out | `docker compose -f docker-compose.prod.yml logs app` on the server. |
