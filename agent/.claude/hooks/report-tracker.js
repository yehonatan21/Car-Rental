#!/usr/bin/env node
'use strict';
// PostToolUse hook (see .claude/settings.json): an audit trail of what the agent did.
//   - every script it ran (Bash) → audit/tool_usage_log.jsonl
//   - every report it wrote or edited (Write/Edit under reports/) → audit/report_history.json
const fs = require('node:fs');
const path = require('node:path');

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const e = JSON.parse(input || '{}');
    const dir = path.join(process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '../..'), 'audit');
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    if (e.tool_name === 'Bash') {
      fs.appendFileSync(path.join(dir, 'tool_usage_log.jsonl'), JSON.stringify({ at, session: e.session_id, command: e.tool_input?.command }) + '\n');
    } else if (['Write', 'Edit', 'MultiEdit'].includes(e.tool_name) && /(^|[/\\])reports[/\\]/.test(e.tool_input?.file_path || '')) {
      const file = path.join(dir, 'report_history.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first entry */ }
      list.push({ at, session: e.session_id, action: e.tool_name === 'Write' ? 'write' : 'edit', report: path.basename(e.tool_input.file_path) });
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
    }
  } catch { /* an audit failure never stops the agent */ }
});
