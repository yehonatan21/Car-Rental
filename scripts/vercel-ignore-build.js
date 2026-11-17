'use strict';
// Vercel "Ignored Build Step" (vercel.json → ignoreCommand): decides whether a push is built. Exit 0 = skip, 1 = build.
// Every deployment Vercel keeps counts toward the plan's storage (Hobby: 10 GB), and one push to main rebuilds every
// client's site. So:
//   - client sites (created by the console: CLIENT_SITE=1) build only main: previews of other branches are never used;
//   - this repository's own site builds main and dev (dev is the test environment), not work or pull-request branches;
//   - a push that changes only documentation or tests is not built.
// A redeploy (same commit, e.g. after changing a variable) and anything this script cannot tell are always built.
const { execFileSync } = require('node:child_process');

/** What the running app is made of; anything else (docs/, test/, README…) does not need a new deployment. */
const APP_PATHS = ['src', 'public', 'api', 'package.json', 'package-lock.json', 'vercel.json'];
const isAppFile = (f) => APP_PATHS.some((p) => f === p || f.startsWith(`${p}/`));

/** changedFiles: the files changed since the branch's last deployment, or null when unknown. */
function decide(env, changedFiles) {
  const branch = env.VERCEL_GIT_COMMIT_REF || '';
  if (!branch) return { build: true, reason: 'not a git push (deployed through the API or CLI)' };
  if (env.CLIENT_SITE === '1' && branch !== 'main') return { build: false, reason: `a client site builds only main, not ${branch}` };
  if (env.CLIENT_SITE !== '1' && !['main', 'dev'].includes(branch)) return { build: false, reason: `only main and dev are built, not ${branch}` };
  if (changedFiles && changedFiles.length && !changedFiles.some(isAppFile)) {
    return { build: false, reason: `only documentation or tests changed (${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? '…' : ''})` };
  }
  return { build: true, reason: changedFiles?.length ? 'the app changed' : 'a new branch, a redeploy, or the changes are unknown' };
}

/** Files changed since this branch's last successful deployment (Vercel gives its commit), or null. */
function changedSinceLastDeployment(env) {
  const prev = env.VERCEL_GIT_PREVIOUS_SHA;
  if (!prev) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', prev, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch {
    return null; // that commit is not in Vercel's shallow clone: build, to be safe
  }
}

module.exports = { decide, changedSinceLastDeployment, APP_PATHS };

if (require.main === module) {
  const d = decide(process.env, changedSinceLastDeployment(process.env));
  console.log(`[ignore-build] ${d.build ? 'building' : 'skipping'}: ${d.reason}`);
  process.exit(d.build ? 1 : 0);
}
