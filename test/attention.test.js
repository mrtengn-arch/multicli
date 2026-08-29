// FILE: test/attention.test.js
// PURPOSE: Regression cases for the "an agent is waiting on you" detection (K17).
// RUN: npm test  (from the repo root)
//
// renderer.js can't be `require`d — it touches `document` at module load — so the two
// pure pieces are pulled out of the source text and evaluated here. That keeps this a
// test of the REAL patterns rather than a copy that can silently drift.
//
// The false-positive half matters more than the true-positive half: a wrong "needs you"
// fires an OS notification, so a shell prompt or Claude's idle input box must never match.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const patterns = src.match(/const ATTENTION_PATTERNS = \[[\s\S]*?\n\];/)[0];
const fn = src.match(/function looksLikeAttention\(lines\) \{[\s\S]*?\n\}/)[0];
eval(`${patterns}\n${fn}`);

const shouldMatch = [
  ['claude yes/no prompt', ['Do you want to make this edit to renderer.js?', '❯ 1. Yes', '  2. No']],
  ['plain question',       ['Which file should I edit?']],
  ['(y/n)',                ['Overwrite existing file? (y/n)']],
  ['[Y/n]',                ['Continue with installation [Y/n]']],
  ['press enter',          ['Press enter to continue']],
  ['select an option',     ['Select an option:', '  1) foo', '  2) bar']],
  ['turkish',              ['Devam etmek istiyor musunuz']],
  ['arrow menu',           ['▶ option one', '  option two']],
];

const shouldNotMatch = [
  ['powershell prompt',  ['PS C:\Users\murat\Projects\multicli>']],
  ['bash prompt',        ['murat@AIO:~/projects$ ']],
  ['claude idle box',    ['╭─────────────╮', '│ > Try "edit"│', '╰─────────────╯']],
  ['plain output',       ['Done. Applied 3 edits to 2 files.']],
  ['npm output',         ['added 214 packages in 3s']],
  ['git status',         ['nothing to commit, working tree clean']],
  ['error text',         ['Error: ENOENT: no such file or directory']],
];

let fails = 0;
for (const [name, lines] of shouldMatch) {
  const got = looksLikeAttention(lines);
  if (!got) { console.log(`FAIL (should be ATTENTION): ${name}`); fails++; }
}
for (const [name, lines] of shouldNotMatch) {
  const got = looksLikeAttention(lines);
  if (got) { console.log(`FAIL (false positive): ${name}`); fails++; }
}
if (fails === 0) {
  console.log(`all ${shouldMatch.length + shouldNotMatch.length} attention-detection cases passed`);
} else {
  console.log(`${fails} case(s) failed`);
  process.exit(1); // so `npm test` actually fails in CI
}
