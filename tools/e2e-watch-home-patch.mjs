// tools/e2e-watch-home-patch.mjs — regression test: home-root cordis.patch.yml
// undo echo suppression.
//   cordis.patch.yml exists in BOTH roots (profile + home) under the same
//   basename. The watcher flush used to reduce config events to basenames and
//   resolve the spec by basename only, so the echo check always picked the
//   profile spec: restoring a HOME patch change read the profile file
//   (missing or different) instead, judged the restore's own write a real
//   change, and produced a spurious auto snapshot that then blocked redo.
//   This fixture has NO profile patch at all:
//   1. home patch change auto-snapshots
//   2. undo restores it; after the pending watcher events are flushed by an
//      unrelated file event, NO new auto snapshot may appear
//   3. redo succeeds (was blocked by the spurious snapshot)
//   4. a real home patch change afterwards still auto-snapshots
// Run:  node tools/e2e-watch-home-patch.mjs
process.env.DSH_ROOT = process.env.DSH_ROOT ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
process.env.DSH_UNDO_LANG = 'en';
import { mkdtemp, writeFile, readFile, mkdir, rm as rmRaw } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const rm = async (dir, opts) => {
  let last;
  for (let i = 0; i < 4; i++) {
    try { await rmRaw(dir, opts); return; } catch (e) { last = e; await new Promise((r) => setTimeout(r, 150)); }
  }
  throw last;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await mkdtemp(join(tmpdir(), 'dsh-undo-e2e-homepatch-'));
const home = join(root, 'home');
const profile = join(root, 'profile');
const snapDir = join(root, 'snapshots');
await mkdir(home, { recursive: true });
await mkdir(profile, { recursive: true });
await writeFile(join(home, 'settings.yaml'), 'model: x\n');
await writeFile(join(home, 'cordis.patch.yml'), '# home patch A\n[]\n');
// NOTE: profile/cordis.patch.yml intentionally absent — same basename, other root.

process.env.DSH_UNDO_SETTINGS = join(root, 'undo', 'settings.json');
process.env.DSH_UNDO_ROOT = join(root, 'undo-snapshots');
const { apply } = await import('../lib/index.js');

const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => { }; } },
  systemPrompt: { section: () => () => { } },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return d ?? (() => { }); },
  logger: { info: () => { }, warn: (...a) => console.warn('[warn]', ...a) },
};
apply(ctx, { manualDir: join(snapDir, 'manual'), autoDir: join(snapDir, 'auto'), homeDir: home, profileDir: profile, watch: true, watchDebounceMs: 300, keepAuto: 10, pluginDirs: [] });
await sleep(600); // baseline lands

let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { pass++; console.log('  ok  -', label); } else { fail++; console.error('  FAIL -', label); } };
const run = async (name, args) => (await tools.get(name).execute(args, {}));
const patchCount = async () => {
  const out = await run('undo_list', {});
  return (out.match(/patch-change/g) || []).length;
};
const curPatch = () => readFile(join(home, 'cordis.patch.yml'), 'utf8');

console.log('== 1. home patch change auto-snapshots ==');
await writeFile(join(home, 'cordis.patch.yml'), '# home patch B\n[]\n');
await sleep(1200);
const before = await patchCount();
check(before >= 1, `auto snapshot appeared (${before})`);

console.log('== 2. undo restores and suppresses its own auto snapshot ==');
const out = await run('undo_restore', { mode: 'undo' });
console.log('   ', out.split('\n')[0]);
check((await curPatch()) === '# home patch A\n[]\n', 'home patch restored to A');
await sleep(1200);
// The restore's own watch events sit in `pending` while suppressAuto>0; any
// later unrelated event in the same dir flushes them through the echo check.
// An unrelated file (never snapshot-worthy by itself) forces that flush.
await writeFile(join(home, 'notes.txt'), 'unrelated\n');
await sleep(1200);
const after = await patchCount();
check(after === before, `no auto snapshot from the undo itself (${before} -> ${after})`);

console.log('== 3. redo succeeds (was blocked by the spurious snapshot) ==');
const redo = await run('undo_restore', { mode: 'redo' });
console.log('   ', redo.split('\n')[0]);
check(!redo.includes('blocked') && !redo.includes('failed'), 'redo not blocked');
check((await curPatch()) === '# home patch B\n[]\n', 'home patch re-applied to B');

console.log('== 4. real home patch change still auto-snapshots ==');
await writeFile(join(home, 'cordis.patch.yml'), '# home patch C\n[]\n');
await sleep(1200);
const afterReal = await patchCount();
check(afterReal > after, `real change snapshotted (${after} -> ${afterReal})`);

await rm(root, { recursive: true, force: true });
console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);
