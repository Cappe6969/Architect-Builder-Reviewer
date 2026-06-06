'use strict';
/**
 * lib/parse.js — the defensive-parsing contract (ADR-0002).
 *
 * SINGLE SOURCE OF TRUTH: imported by BOTH ship.js (production loop) and
 * simulate.js / calibrate.js (the Calibration Cycle). Testing a copy that
 * could drift from production would defeat the purpose.
 *
 * Headless LLM CLIs cannot be trusted to emit clean JSON — they wrap it in
 * markdown fences, prepend conversational prose, or append trailing chatter.
 * These helpers extract usable JSON from that noise without ever throwing.
 */

/**
 * defensiveJsonParse(raw) -> object | array | null
 * Strip markdown fences, slice to the outermost JSON token, JSON.parse in
 * try/catch. Returns null on total failure (caller triggers a coerce pass).
 */
function defensiveJsonParse(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  t = t.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim(); // strip fences
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); }
  catch { return null; }
}

/**
 * extractUsageTokens(outer) -> number
 * CALIBRATE: confirm the real envelope field. Handles `usage.total_tokens`,
 * `token_usage.total`, and input+output split. Returns 0 when absent — which
 * means the token-budget rail is BLIND for that engine (a calibration finding).
 */
function extractUsageTokens(outer) {
  if (!outer || typeof outer !== 'object') return 0;
  const u = outer.usage || outer.token_usage || {};
  const n = (typeof u.total_tokens === 'number') ? u.total_tokens
    : (typeof u.total === 'number') ? u.total
    : ((u.input_tokens || 0) + (u.output_tokens || 0));
  return (typeof n === 'number' && Number.isFinite(n)) ? n : 0;
}

/**
 * extractBody(outer) -> any
 * CALIBRATE: confirm the real result field. Unwraps a CLI envelope's `result`
 * if present, else returns the parsed value as-is.
 */
function extractBody(outer) {
  if (outer && typeof outer === 'object' && !Array.isArray(outer) && 'result' in outer) {
    return outer.result;
  }
  return outer;
}

module.exports = { defensiveJsonParse, extractUsageTokens, extractBody };
