'use strict';
// Vercel "Ignored Build Step" (vercel.json → ignoreCommand): decides whether a push is built. Exit 0 = skip, 1 = build.
// Only production is deployed on Vercel: every deployment Vercel keeps counts toward the plan's storage (Hobby: 10 GB),
// and one push rebuilds every client's site. So:
//   - only the main branch is built (production); dev, work and pull-request branches are not (vercel.json also turns
//     off automatic deployments for the usual ones: git.deploymentEnabled).
// Every deployment of main is built, docs-only ones too: a redeploy to apply new variables must never be skipped.
const { execFileSync } = require('node:child_process');


/** changedFiles: the files changed since the branch's last deployment, or null when unknown. */
function decide(env, changedFiles) {
  const branch = env.VERCEL_GIT_COMMIT_REF || '';
  if (!branch) return { build: true, reason: 'not a git push (deployed through the API or CLI)' };
  if (branch !== 'main') return { build: false, reason: `only main (production) is deployed, not ${branch}` };
  // Not skipped on main even when only docs changed: Vercel cannot tell this script whether a deployment is a push or
  // a redeploy to apply changed variables (the console's "rebuild" and "set the key"), and a skipped redeploy silently
  // leaves the old variables in place.
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

module.exports = { decide, changedSinceLastDeployment };

if (require.main === module) {
  const d = decide(process.env, changedSinceLastDeployment(process.env));
  console.log(`[ignore-build] ${d.build ? 'building' : 'skipping'}: ${d.reason}`);
  process.exit(d.build ? 1 : 0);
}
