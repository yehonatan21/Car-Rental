# Chief of Staff agent for a Car-Rental site

An assistant for a site manager, built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). It is
adapted from the Claude cookbook
[The chief of staff agent](https://platform.claude.com/cookbook/claude-agent-sdk-01-the-chief-of-staff-agent). Ask it
about your site in plain Hebrew (or English):

- "כמה השתמשו ברכב בחודש האחרון, ומתי הכי עמוס?"
- "מה מחכה לטיפול שלי?"
- "האם כדאי להפעיל אישור אוטומטי של בקשות?"
- "/weekly-report"

It reads the site's data **read-only** through the scripts in `scripts/`, delegates to two subagents, answers in a
short "executive" style and can save reports under `reports/`. An audit log of every script it ran and every report
it wrote is kept in `audit/`. It runs on your computer, not on Vercel. Nothing here is deployed with the sites.

## Parts (as in the cookbook)

| Cookbook | Here |
|---|---|
| `CLAUDE.md` (company context) | `CLAUDE.md`: the role, the scripts, the data model, privacy rules |
| `scripts/*.py` (financial models) | `scripts/overview.js`, `bookings.js`, `utilization.js`, `users.js`, `sql.js` (read-only, JSON output) |
| `financial-analyst` subagent | `.claude/agents/bookings-analyst.md` and `users-reviewer.md` |
| `/budget-impact` command | `.claude/commands/weekly-report.md`, `pending.md`, `utilization.md` |
| `executive` output style | `.claude/output-styles/executive.md` (Hebrew, decision first) |
| `report-tracker` hook | `.claude/hooks/report-tracker.js`, configured in `.claude/settings.json` |
| Plan mode | `node agent.js --plan "…"` |

## Setup

```bash
cd agent
npm install
export ANTHROPIC_API_KEY=…          # or sign in with `ant auth login`
```

Point it at one site's database. It is only ever read; nothing is changed.

- **A site on Vercel/Turso:** create a read-only token and use the database URL from the site's Vercel project
  (`LIBSQL_URL` / `TURSO_DATABASE_URL`):
  ```bash
  turso db tokens create car-rental-gmach-car-biet-hagi --read-only
  export TURSO_DATABASE_URL=libsql://car-rental-gmach-car-biet-hagi-<org>.aws-eu-central-1.turso.io
  export TURSO_AUTH_TOKEN=<the read-only token>
  ```
- **A local database:** `export DATA_DIR=/path/to/data` (default: the repository's `data/`).

Check the connection without the agent, which is free: `node scripts/overview.js`.

## Use

```bash
node agent.js "מה מחכה לטיפול שלי?"
node agent.js /pending
node agent.js /utilization 60
node agent.js /weekly-report            # writes reports/weekly-<date>.md
node agent.js --plan "תכנן איך להגדיל את השימוש ברכב"   # a plan only, nothing runs
node agent.js --continue "ומה לגבי החודש הקודם?"
node agent.js --style default "…"       # a full answer instead of the short one
```

Each run uses the Claude API (`claude-opus-5-5` by default; `AGENT_MODEL` to change it) and stops at
`AGENT_MAX_USD` dollars (default 2). The cost of each run is printed at the end.

## Safety

- The database is opened read-only (a local file in read-only mode; for Turso, use a read-only token). The scripts
  also refuse any statement other than one `SELECT`.
- ID numbers, phone numbers, password and token hashes and license photo names are never output, and
  `sql.js` refuses queries that name them.
- The agent runs in `dontAsk` mode. It may only read this folder, run `node scripts/…`, delegate to its subagents and
  write under `reports/`. Anything else is refused, and the web is off.
