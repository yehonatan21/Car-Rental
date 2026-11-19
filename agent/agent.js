#!/usr/bin/env node
'use strict';
// The Car-Rental chief of staff: a Claude Agent SDK agent that answers a site manager's questions from the site's
// data (read-only), delegates to two subagents and writes reports. Adapted from the Claude cookbook
// "The chief of staff agent" (claude_agent_sdk/01_The_chief_of_staff_agent.ipynb).
//
//   node agent.js "כמה השתמשו ברכב החודש?"
//   node agent.js /weekly-report            (also /pending, /utilization 60)
//   node agent.js --plan "…"                 plan only, run nothing
//   node agent.js --continue "…"             continue the last conversation
//   node agent.js --style default "…"        full answers instead of the short "executive" style
//
// Needs ANTHROPIC_API_KEY (or `ant auth login`) and the site's database: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (a
// read-only token) or DATA_DIR for a local one. Each run costs API usage, capped by AGENT_MAX_USD (default 2).

const MODEL = process.env.AGENT_MODEL || 'claude-opus-5-5';

function parseArgs(argv) {
  const o = { plan: false, cont: false, style: 'executive', words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') o.plan = true;
    else if (a === '--continue') o.cont = true;
    else if (a === '--style') o.style = argv[++i];
    else o.words.push(a);
  }
  o.prompt = o.words.join(' ').trim();
  return o;
}

/** The Agent SDK options for one run (exported so the tests can check them without calling the API). */
function optionsFor(o) {
  return {
    cwd: __dirname, // CLAUDE.md, .claude/agents, .claude/commands, output styles and hooks are found here
    model: MODEL,
    settingSources: ['project'], // only this folder's settings, not the user's ~/.claude
    settings: o.style === 'default' ? {} : { outputStyle: o.style },
    systemPrompt: {
      type: 'preset', preset: 'claude_code',
      append: 'You are the chief of staff described in CLAUDE.md. Delegate analysis to the bookings-analyst and users-reviewer subagents.',
    },
    // What it may do without asking: read this folder, run the read-only scripts, delegate, and write reports.
    allowedTools: ['Read', 'Grep', 'Glob', 'Agent', 'Bash(node scripts/*)', 'Write(reports/**)', 'Edit(reports/**)'],
    disallowedTools: ['WebSearch', 'WebFetch'],
    permissionMode: o.plan ? 'plan' : 'dontAsk', // anything not allowed above is refused, never prompted
    continue: o.cont,
    maxTurns: 40,
    maxBudgetUsd: Number(process.env.AGENT_MAX_USD) || 2,
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.prompt) {
    console.error('Usage: node agent.js [--plan] [--continue] [--style executive|default] "question" (or /weekly-report, /pending, /utilization)');
    process.exitCode = 2;
    return;
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  for await (const m of query({ prompt: o.prompt, options: optionsFor(o) })) {
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const block of m.message.content || []) {
        if (block.type !== 'tool_use') continue;
        const what = block.name === 'Bash' ? block.input.command
          : block.name === 'Agent' ? `→ ${block.input.subagent_type || 'subagent'}` : block.input.file_path || '';
        process.stderr.write(`  · ${block.name} ${what}\n`);
      }
    } else if (m.type === 'result') {
      if (m.subtype === 'success') process.stdout.write(`\n${m.result}\n`);
      else process.stderr.write(`\nStopped: ${m.subtype}${m.errors?.length ? ` (${m.errors.join('; ')})` : ''}\n`);
      process.stderr.write(`\n[${m.num_turns ?? '?'} turns · $${(m.total_cost_usd || 0).toFixed(3)} · session ${m.session_id}]\n`);
      if (m.is_error) process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, optionsFor, MODEL };
