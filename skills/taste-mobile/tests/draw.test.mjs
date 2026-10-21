import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/draw.mjs');
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding:'utf8' });

// Reproducible option generation ensures design feedback isn't invalidated
// by different random suggestions every session.
test('deterministic JSON with three distinct mobile directions', () => {
  const flags = ['--product','OLFUNA perfume bottle scanner and collection','--category','collection','--mood','refined','--options','3','--json'];
  const a = JSON.parse(run(...flags));
  const b = JSON.parse(run(...flags));
  assert.deepEqual(a,b);
  assert.equal(a.directions.length,3);
  assert.equal(new Set(a.directions.map(d => d.id)).size, 3);
  assert.equal(new Set(a.directions.map(d => d.axis)).size, 3);
  assert.ok(a.directions.every(d => d.risk && d.motion && d.composition));
});

test('a toy creator brief gives a different lead suggestion from perfume archive', () => {
  const a = JSON.parse(run('--product','OLFUNA bottle perfume collection','--category','collection','--mood','refined','--json'));
  const b = JSON.parse(run('--product','Modern Toybox kids paper sticker drawing','--category','creation','--mood','playful','--json'));
  assert.notEqual(a.directions[0].id, b.directions[0].id);
});

test('writes markdown file with meaningful steps and no claimed inspection', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-mobile-'));
  try {
    const out = path.join(folder,'directions.md');
    run('--product','Offline PDF utility','--category','utility','--out',out);
    const text = fs.readFileSync(out,'utf8');
    assert.match(text,/Design direction deal/);
    assert.match(text,/Competitor-swap test/);
    assert.match(text,/no benchmark research, preview rendering, or device inspection/i);
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});

test('validates arguments and prints help', () => {
  assert.match(run('--help'),/Node 18\+/);
  assert.equal(run('--list').trim().split('\n').length, 12);
  const p = spawnSync(process.execPath, [script,'--product','test','--category','nonsense'],{encoding:'utf8'});
  assert.equal(p.status, 2);
  assert.match(p.stderr,/unknown category/);
});
