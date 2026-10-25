# Hosting for free

The app stores its database (SQLite) and the uploaded driving-license images **on disk**, so it needs a host
with a **persistent disk**. That rules out most free "app platform" tiers. Render's free web services lose
local files on every restart/redeploy and can't attach a disk, and Fly.io no longer has a free tier.
What does work for free is a **free virtual server**, using the setup script and CI/CD that are already in this repo.

| Option | Cost | Good for | Catch |
|---|---|---|---|
| **Oracle Cloud Always Free** (recommended) | Free with no time limit | Always-on dev or small production | Credit card needed for sign-up (not charged); free ARM capacity is sometimes "out of capacity"; idle free VMs may be reclaimed |
| Google Cloud e2-micro (Always Free) | Free VM in us-west1 / us-central1 / us-east1 | Always-on dev | 1 GB RAM; the public IPv4 address may be billed (a few $/month); servers are in the US |
| Your PC + Cloudflare Tunnel | Free | Demos while your PC is on | Random `trycloudflare.com` address (`npm run tunnel`); a fixed address needs a domain on Cloudflare |
| Render free web service | Free | Throw-away demos only | **Data is wiped** on every restart/deploy; sleeps after 15 min idle |

Free-tier terms change often. Check the provider's own page before relying on any of this.

---

## Oracle Cloud Always Free, step by step

### 1. Create the account
Sign up at **https://www.oracle.com/cloud/free/**. Choose a **home region** close to your users (it can't be changed
later). A credit card is required for identity verification; Always Free resources are not charged.

### 2. Create the server (instance)
In the console: **☰ → Compute → Instances → Create instance**.

- **Name:** `car-rental-dev`
- **Image:** Canonical **Ubuntu 24.04**
- **Shape:** *Change shape* →
  - **Ampere (ARM) → VM.Standard.A1.Flex**: **1 OCPU, 6 GB RAM** (well within the Always Free allowance), or
  - **AMD → VM.Standard.E2.1.Micro** (1 GB RAM) if no Ampere capacity is available.
  The image is built for both ARM and x86, so either works.
- **Networking:** keep the default new VCN and public subnet, with **Assign a public IPv4 address** checked.
- **SSH keys:** upload your public key (or let Oracle generate a key pair and **download the private key**).
- **Boot volume:** default size (≈47 GB) is fine.

Click **Create**. When it is *Running*, copy the **Public IP address**.

> "Out of capacity" for A1? Try another availability domain (AD-2/AD-3) in the same screen, try again later,
> or use the E2.1.Micro shape.

### 3. Open ports 80 and 443 in Oracle's network firewall
Instance page → **Subnet** link → **Security Lists** → *Default Security List* → **Add Ingress Rules**:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | UDP | `443` |

(Port 22 for SSH is open by default.) The server's own firewall rules are handled by the setup script in step 5.

### 4. Create the deploy key (on your PC)
```bash
ssh-keygen -t ed25519 -C "github-actions-car-rental-dev" -f car-rental-dev-deploy -N ""
```

### 5. Install the app on the server (one command)
```bash
ssh ubuntu@<PUBLIC-IP>            # Oracle's Ubuntu user is "ubuntu"
sudo -i
curl -fsSL https://raw.githubusercontent.com/yehonatan21/car-rental/dev/scripts/server-setup.sh \
  | bash -s -- --env dev --key "<contents of car-rental-dev-deploy.pub>"
```
The script:
- installs Docker,
- opens 80/443 in Ubuntu's firewall rules,
- creates the `deploy` user,
- writes `/opt/car-rental/.env`,
- starts the app behind Caddy with automatic HTTPS.

At the end it prints the address, for example **`https://dev.129-146-10-20.sslip.io`**. That's a free host name that
needs no domain purchase; use `--domain dev.yourdomain.com` if you have one.

### 6. Create your admin account
```bash
cd /opt/car-rental
docker compose -f docker-compose.prod.yml exec app node scripts/create-admin.js --email you@example.com --password 'a-strong-password'
```

### 7. Automatic deploys from GitHub
GitHub → **Settings → Environments → `development`**:

- **Secrets:**
  - `DEPLOY_SSH_HOST`: the public IP
  - `DEPLOY_SSH_KEY`: the private key file contents
  - `DEPLOY_SSH_KNOWN_HOSTS`: output of `ssh-keyscan -H <PUBLIC-IP>`
- **Variable:** `APP_URL`: the printed `https://…` address

Every push to `dev` now tests, builds and deploys to this server. Details and day-to-day commands are in
[dev-environment.md](dev-environment.md).

### Keeping it free and running
- Stay within the Always Free shapes and the default boot volume; the console marks eligible resources **"Always Free"**.
- Oracle may reclaim Always Free compute instances that sit idle for a long time. A small app with regular
  use and periodic deploys normally stays active, but check Oracle's current Always Free policy.
- Back up the data volume now and then (command in [dev-environment.md](dev-environment.md#day-to-day)).
