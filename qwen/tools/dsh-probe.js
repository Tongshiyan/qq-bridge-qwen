// ============================================================
//  dsh-probe.js -- verify the DSH installation layout on THIS PC.
//
//  Run with the DSH Electron binary in Node mode (that is the only
//  way to see inside app.asar, which is a single archive FILE):
//
//    set ELECTRON_RUN_AS_NODE=1
//    "<DshRoot>\DeepSeek Harness.exe" "<this file>" [DshRoot]
//
//  Prints one JSON object on stdout:
//    {
//      "nodeVersion": "...",
//      "dshRoot": "...",
//      "found": { "exe": true, "pnpmCjs": true, "cliCmd": true, "jsEntry": true },
//      "jsEntry": "<resolved or null>",
//      "notes": [ ... ]
//    }
//
//  If the expected jsEntry path is missing (newer/older DSH packaging),
//  it searches resources\app.asar for "dsh-desktop-host/lib/cli.js"
//  and reports the first match, so install.ps1 can rewrite the bridge
//  config automatically instead of failing.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const root = (process.argv[2] || process.env.QWEN_DSH_ROOT || '').trim();

const notes = [];
const result = {
  nodeVersion: process.version,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
  dshRoot: root || null,
  found: { exe: false, pnpmCjs: false, cliCmd: false, jsEntry: false },
  jsEntry: null,
  notes,
};

if (!root) {
  notes.push('no DSH root given (argv[2] or QWEN_DSH_ROOT)');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(2);
}

const exePath = path.join(root, 'DeepSeek Harness.exe');
const pnpmCjs = path.join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs');
const cliCmd = path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
const asarPath = path.join(root, 'resources', 'app.asar');
const expectedJsEntry = path.join(
  asarPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'
);

function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

result.found.exe = exists(exePath);
result.found.pnpmCjs = exists(pnpmCjs);
result.found.cliCmd = exists(cliCmd);
result.found.jsEntry = exists(expectedJsEntry);

if (result.found.jsEntry) {
  result.jsEntry = expectedJsEntry;
} else {
  notes.push('expected jsEntry not found: ' + expectedJsEntry);
  // Bounded breadth-first search inside the asar archive.
  const target = path.join('@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const queue = [asarPath];
  let visited = 0;
  let foundPath = null;
  while (queue.length && visited < 4000 && !foundPath) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      visited++;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (full.endsWith(target)) { foundPath = full; break; }
        if (ent.name !== 'locales') queue.push(full);
      }
    }
  }
  if (foundPath) {
    result.jsEntry = foundPath;
    result.found.jsEntry = true;
    notes.push('jsEntry discovered by search: ' + foundPath);
  } else {
    notes.push('search inside app.asar did not find dsh-desktop-host/lib/cli.js');
  }
}

result.found.asar = exists(asarPath);
result.paths = { exePath, pnpmCjs, cliCmd, asarPath };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.found.exe && result.found.jsEntry ? 0 : 1);
