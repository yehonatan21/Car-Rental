'use strict';
// Express's URL parsing (the parseurl package) calls url.parse(), which newer Node versions (Vercel runs 24.x) flag
// with deprecation warning DEP0169 on every new server instance. It is harmless here, but it shows up in the Vercel
// logs as a red "error" line and hides real problems, so that one warning is dropped. Everything else still prints.
const emitWarning = process.emitWarning;
process.emitWarning = function quietEmitWarning(warning, ...args) {
  const code = args[0] && typeof args[0] === 'object' ? args[0].code : args[1];
  if (code === 'DEP0169') return undefined;
  return emitWarning.call(this, warning, ...args);
};
