#!/usr/bin/env node
'use strict';
/**
 * simulate.js — Data Contract & Response Simulator
 * -------------------------------------------------
 * Offline half of the Calibration Cycle. Feeds the PRODUCTION defensive parser
 * (lib/parse.js — the same code ship.js runs) a battery of real-world CLI
 * output variations and reports how it copes BEFORE we go live.
 *
 * Zero risk, zero CLIs, zero tokens. Run: `node simulate.js`
 * Exit 0 if all non-risky fixtures behave as expected, else exit 1.
 */

const { defensiveJsonParse, extractUsageTokens, extractBody } = require('./lib/parse');

// Each fixture mimics a way fcc-claude / codex exec might really answer.
// expect: 'object' | 'array' | 'null'   (the parsed top-level type)
// tokens: expected value from extractUsageTokens
// risky:  parses successfully but is semantically dangerous (documented, not failed)
const FIXTURES = [
  { name: 'clean object',               raw: '{"verdict":"pass","findings":[]}',                                   expect: 'object', tokens: 0 },
  { name: 'markdown-fenced json',       raw: '```json\n{"verdict":"pass","findings":[]}\n```',                     expect: 'object', tokens: 0 },
  { name: 'conversational preamble',    raw: 'Here are my findings:\n{"verdict":"fail","findings":[{"severity":"High"}]}', expect: 'object', tokens: 0 },
  { name: 'preamble + fence',           raw: 'Sure! Here you go:\n```json\n{"verdict":"pass"}\n```',               expect: 'object', tokens: 0 },
  { name: 'trailing prose after json',  raw: '{"verdict":"pass"}\nLet me know if you need anything else.',         expect: 'object', tokens: 0 },
  { name: 'top-level array',            raw: '[{"severity":"High","file":"a.js","line":42}]',                      expect: 'array',  tokens: 0 },
  { name: 'envelope w/ usage',          raw: '{"result":{"verdict":"pass"},"usage":{"total_tokens":1234}}',        expect: 'object', tokens: 1234 },
  { name: 'envelope alt usage in/out',  raw: '{"result":{"verdict":"pass"},"usage":{"input_tokens":1000,"output_tokens":234}}', expect: 'object', tokens: 1234 },
  { name: 'missing usage (blind meter)',raw: '{"verdict":"pass"}',                                                 expect: 'object', tokens: 0 },
  { name: 'truncated json',             raw: '{"verdict":"fail","findings":[{"severity":"Hi',                      expect: 'null',   tokens: 0 },
  { name: 'prose only (no json)',       raw: 'I have completed the task successfully.',                            expect: 'null',   tokens: 0 },
  { name: 'empty string',               raw: '',                                                                   expect: 'null',   tokens: 0 },
  { name: 'BOM + leading whitespace',   raw: '﻿  \n{"verdict":"pass"}',                                       expect: 'object', tokens: 0 },
  { name: 'prose w/ stray braces',      raw: 'Done. Updated handler() {}',                                         expect: 'object', tokens: 0, risky: true },
];

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v; }

let failures = 0;
const rows = [];
for (const fx of FIXTURES) {
  const parsed = defensiveJsonParse(fx.raw);
  const ptype = typeOf(parsed);
  const tokens = extractUsageTokens(parsed);
  const body = extractBody(parsed);

  const typeOk = ptype === fx.expect;
  const tokOk = tokens === fx.tokens;
  // A parsed object that lacks the keys ship.js relies on would cause a FALSE
  // clean pass (findings undefined -> [] -> zero High). Flag it.
  const semanticRisk = ptype === 'object' && body && typeof body === 'object'
    && !Array.isArray(body) && !('verdict' in body) && !('status' in body) && !('findings' in body);

  let verdict;
  if (!typeOk || !tokOk) { verdict = 'FAIL'; if (!fx.risky) failures++; }
  else if (fx.risky || semanticRisk) verdict = 'WARN';
  else verdict = 'PASS';

  rows.push({ name: fx.name, got: ptype, exp: fx.expect, tok: `${tokens}/${fx.tokens}`, risk: semanticRisk ? 'empty-shape' : '', verdict });
}

// Render
const pad = (s, n) => String(s).padEnd(n);
console.log('\n  Data Contract & Response Simulator — parser resilience\n');
console.log('  ' + pad('fixture', 28) + pad('got', 8) + pad('exp', 8) + pad('tokens', 10) + pad('risk', 13) + 'verdict');
console.log('  ' + '-'.repeat(74));
for (const r of rows) {
  console.log('  ' + pad(r.name, 28) + pad(r.got, 8) + pad(r.exp, 8) + pad(r.tok, 10) + pad(r.risk, 13) + r.verdict);
}
const pass = rows.filter(r => r.verdict === 'PASS').length;
const warn = rows.filter(r => r.verdict === 'WARN').length;
const fail = rows.filter(r => r.verdict === 'FAIL').length;
console.log('\n  ' + `${pass} PASS · ${warn} WARN · ${fail} FAIL` + '\n');

if (warn) {
  console.log('  WARN = parses successfully but is semantically dangerous:');
  console.log('  a parsed object missing verdict/status/findings keys would yield zero');
  console.log('  High findings -> a FALSE clean pass. Recommend a shape-validation guard');
  console.log('  in ship.js (treat key-less objects as a parse failure -> coerce pass).\n');
}

process.exit(failures > 0 ? 1 : 0);
