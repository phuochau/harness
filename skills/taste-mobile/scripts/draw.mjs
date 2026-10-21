#!/usr/bin/env node
/**
 * Taste Mobile design-direction dealer.
 * Dependency-free, deterministic heuristic prompts; not a design-quality model.
 * Inspired by Taste Skill's exploratory "deal directions" concept, with
 * original mobile-specific data, selection and output implementation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const directions = JSON.parse(fs.readFileSync(path.join(here, 'direction-library.json'), 'utf8'));
const categories = new Set(['collection','creation','utility','productivity','kids','finance','learning','travel','storytelling','health','commerce']);
const args = process.argv.slice(2);
const opts = { options: 3, product: '', category: '', mood: '', seed: '', out: '', json: false, list: false };

const usage = `Taste Mobile direction dealer (Node 18+, no dependencies)

Usage:
  node scripts/draw.mjs --product "APP NAME: main user job" [flags]

Flags:
  --category    ${[...categories].join(' | ')}
  --mood        refined | playful | precise | warm | quiet | ... (free text)
  --options     1–5, default 3; select 3 for full exploration
  --seed        optional seed; same input + seed -> same result
  --out         write .md (or .json) report to this path
  --json        print machine-readable JSON to stdout
  --list        list direction IDs
  --help        show this help

Examples:
  node scripts/draw.mjs --product "OLFUNA perfume collection" --category collection --mood refined --options 3
  node scripts/draw.mjs --product "Kids paper outfit toybox" --category creation --mood playful --out .taste-mobile/directions.md

The score is a heuristic affinity for exploration, not design excellence.
`;

function fail(message) { process.stderr.write(`Error: ${message}\n\n${usage}`); process.exit(2); }
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--help' || flag === '-h') { process.stdout.write(usage); process.exit(0); }
  if (flag === '--list') { opts.list = true; continue; }
  if (flag === '--json') { opts.json = true; continue; }
  if (!['--product','--category','--mood','--options','--seed','--out'].includes(flag)) fail(`unknown flag '${flag}'`);
  if (i + 1 >= args.length || args[i + 1].startsWith('--')) fail(`missing value after ${flag}`);
  const key = flag.slice(2);
  opts[key] = args[++i];
}
if (opts.list) { for (const d of directions) console.log(`${d.id.padEnd(22)} ${d.name} [${d.axis}]`); process.exit(0); }
if (!opts.product || !String(opts.product).trim()) fail('--product is required');
if (opts.category && !categories.has(opts.category.toLowerCase())) fail(`unknown category '${opts.category}'`);
opts.options = Number(opts.options);
if (!Number.isInteger(opts.options) || opts.options < 1 || opts.options > 5) fail('--options must be an integer from 1 to 5');

const clean = value => String(value || '').trim().toLowerCase();
const productText = clean(opts.product);
const category = clean(opts.category);
const mood = clean(opts.mood);
const seedText = `${clean(opts.seed)}|${productText}|${category}|${mood}`;
function hash(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function fingerprint(d) { return (hash(seedText + '|' + d.id) % 10000) / 10000; }
function affinity(d) {
  let points = 0;
  const why = [];
  if (category && d.categories.includes(category)) { points += 6; why.push('category-fit'); }
  if (mood && d.moods.some(m => mood === m || mood.includes(m) || m.includes(mood))) { points += 3; why.push('mood-fit'); }
  const relevant = d.keywords.filter(kw => productText.includes(kw.toLowerCase()));
  if (relevant.length) { points += Math.min(3, relevant.length) * 2; why.push(`material: ${relevant.slice(0,3).join(', ')}`); }
  return { points, why: why.length ? why : ['deliberate counter-direction'] };
}
const candidates = directions.map(d => ({ ...d, ...affinity(d), tie: fingerprint(d) }));
const chosen = [];
while (chosen.length < opts.options && chosen.length < candidates.length) {
  const remaining = candidates.filter(x => !chosen.some(y => y.id === x.id));
  // A true alternate concept changes the composition/interaction axis, not
  // merely the palette. Prefer a new axis until each axis has been sampled.
  const unusedAxis = remaining.filter(x => !chosen.some(y => y.axis === x.axis));
  const pool = unusedAxis.length ? unusedAxis : remaining;
  pool.sort((a,b) => (b.points - a.points) || (b.tie - a.tie) || a.id.localeCompare(b.id));
  chosen.push(pool[0]);
}
const result = {
  product: opts.product,
  category: category || 'unspecified',
  mood: mood || 'unspecified',
  disclaimer: 'These are curated prompts. Scores measure heuristic affinity, not quality, awards, or evidence.',
  directions: chosen.map(({ tie, ...d }) => d)
};

const esc = value => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function toMarkdown(r) {
  const lines = [
    '# Taste Mobile · Design direction deal', '',
    `**Product:** ${esc(r.product)}`,
    `**Category / mood:** ${esc(r.category)} / ${esc(r.mood)}`, '',
    `> ${r.disclaimer}`, '',
    '**Before choosing:** list 8–12 product-specific materials; identify the primary job; compare at least two connected screens per direction.', '',
  ];
  for (let i = 0; i < r.directions.length; i++) {
    const d = r.directions[i];
    lines.push(`## ${i+1}. ${d.name} · ${d.id}`, '',
      `**Affinity clues:** ${d.why.join('; ')} (heuristic ${d.points}; not a quality score)`, '',
      `- **Design proposition:** ${d.idea}`,
      `- **Composition:** ${d.composition}`,
      `- **Typography:** ${d.typography}`,
      `- **Color roles:** ${d.palette}`,
      `- **Material / imagery:** ${d.material}`,
      `- **Motion:** ${d.motion}`,
      `- **Potential signature moment:** ${d.signature}`,
      `- **Risk:** ${d.risk}`, '',
      '**Complete with product-specific decisions:**',
      '1. In this app, **[unique object/ritual]** becomes **[visual/interaction device]** so **[user job]** feels **[emotion]**.',
      '2. Sketch/render **home + decisive action/result** using the *same* sample content for all options.',
      '3. Pick layout hierarchy, color tokens, exact font choices and reduced-motion fallback.',
      '4. Competitor-swap test: why would this not fit an adjacent app unchanged?', '',
    );
  }
  lines.push('## Decision gate', '',
    'Choose on product fit, design distinction, clarity, accessibility, asset availability and implementation feasibility.',
    'Do **not** combine all three into a bland hybrid. The chosen design should become `DESIGN.md`.', '',
    'Generated by `taste-mobile/scripts/draw.mjs`; no benchmark research, preview rendering, or device inspection was performed by this script.', '');
  return lines.join('\n');
}
const output = opts.json ? JSON.stringify(result, null, 2) + '\n' : toMarkdown(result);
if (opts.out) {
  const outPath = path.resolve(process.cwd(), opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fileOutput = opts.out.endsWith('.json') ? JSON.stringify(result, null, 2) + '\n' : toMarkdown(result);
  fs.writeFileSync(outPath, fileOutput, 'utf8');
  if (!opts.json) process.stdout.write(`Wrote: ${outPath}\n`);
}
if (!opts.out || opts.json) process.stdout.write(output);
