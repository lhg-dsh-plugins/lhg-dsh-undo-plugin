/**
 * dsh-undo-savepoint: 存量快照脱敏清理（W49，issue #39）。
 *
 * 用途：把「新清单生效前」已经以明文落盘的敏感快照（补丁层 cordis.patch.yml /
 * cordis.yml 等）就地清理。默认只报告，--apply 才落盘。
 *
 * 处理动作（对齐 W37 的入库守卫语义）：
 *   1. 快照内该文件的明文原件走 writeVault 挪入 vault（内容寻址，不裸写）；
 *   2. vault ref 写进该快照 manifest 的 envVaultRefs（键为 dest 名）；
 *   3. 快照内的文件替换为脱敏副本。
 *   4. 顺序：本工具只替换值，不改块结构。若同一份 cordis.patch.yml 还要跑 W46 的
 *      悬空 insert 清理，先跑 W46 再跑本工具：脱敏会把值换成占位符，但块结构与键名
 *      保留，清理函数仍认得出条目；反序则不保证。
 *
 * 与 lib/snapshot.mjs 采集侧的分工：采集侧遇到「活文件已含占位符」会拒入 vault
 * （守卫一，redactedPreexisting）；本工具处理的是历史存量，明文原件是权威值，故正常入库。
 *
 * 幂等：第二次跑时全部命中项落「已脱敏」分支，处理数为 0。
 *
 * 用法：
 *   node tools/redact-existing.mjs [--dir <快照目录>] [--profile <名>] [--apply] [--json]
 *
 * --dir 给定时扫该目录（其内含 manifest.json 视为单个快照；否则视为快照仓库根）；
 * 默认扫当前 profile 的 auto 区。--apply 才写盘，不带时磁盘逐字节不变。
 * vault 落在被扫仓库根下的 env-vault（与采集侧同址）。
 *
 * 本工具不 import lib/index.js（插件入口有注册工具、读 consent、建快捷方式等副作用），
 * 只 import lib/base.mjs；也不引入任何子进程调用。
 *
 * @module dsh-undo-savepoint/redact-existing
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SENSITIVE_DESTS,
  REDACTED_PLACEHOLDER,
  buildConfig,
  pathExists,
  readManifest,
  redactByDest,
  sha1Hex,
  writeManifest,
  writeVault,
} from '../lib/base.mjs';

/** 扫一个快照目录；vaultRoot 为 vault 落点（该快照仓库根）。 */
async function scanSnapshot(cfg, dir, vaultRoot) {
  let manifest;
  try { manifest = await readManifest(dir); } catch { return null; }

  const vaultCfg = { ...cfg, autoDir: vaultRoot };
  const processed = [];
  const skipped = [];
  let vaultAdded = 0;

  let entries;
  try { entries = await fs.readdir(dir); } catch { return null; }
  for (const name of entries.filter((n) => SENSITIVE_DESTS.has(n)).sort()) {
    const p = join(dir, name);
    if (!(await pathExists(p))) continue;
    let buf;
    try { buf = await fs.readFile(p); } catch { continue; }
    const text = buf.toString('utf8');
    const redactedText = redactByDest(name, text);
    if (redactedText === text) {
      // 脱敏后逐字节不变：本来就是脱敏版（含占位符），或没有可脱敏的值。
      skipped.push({ name, why: text.includes(REDACTED_PLACEHOLDER) ? 'already-redacted' : 'no-plaintext' });
      continue;
    }
    // 明文命中。
    if (!cfg.apply) { processed.push({ name, bytes: buf.length }); continue; }
    const sha = sha1Hex(buf);
    await writeVault(vaultCfg, sha, buf);
    if (!manifest.envVaultRefs || typeof manifest.envVaultRefs !== 'object') manifest.envVaultRefs = {};
    if (manifest.envVaultRefs[name] !== sha) vaultAdded++;
    manifest.envVaultRefs[name] = sha;
    await fs.writeFile(p, redactedText, 'utf8');
    processed.push({ name, bytes: buf.length, sha });
  }

  if (cfg.apply && processed.length > 0) await writeManifest(dir, manifest);
  return { dir, processed, skipped, vaultAdded };
}

/**
 * 遍历并汇总。
 * @param {object} cfg 引擎 cfg；cfg.apply 控制是否落盘，cfg.scanDir/cfg.singleDir 控制扫描面
 * @returns {Promise<object>} 结构化报告
 */
export async function run(cfg) {
  const root = cfg.scanDir ?? cfg.autoDir;
  let dirs;
  if (cfg.singleDir) {
    dirs = [root];
  } else {
    try {
      dirs = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name !== 'env-vault' && !e.name.startsWith('.'))
        .map((e) => join(root, e.name));
    } catch { dirs = []; }
  }

  // vault 落点：单快照模式取该快照的父目录；仓库根模式即根目录。
  const vaultRoot = cfg.singleDir ? (cfg.vaultRoot ?? join(root, '..')) : root;

  const snapshots = [];
  for (const dir of dirs) {
    const r = await scanSnapshot(cfg, dir, vaultRoot);
    if (r && (r.processed.length > 0 || r.skipped.length > 0)) snapshots.push(r);
  }

  const byDest = new Map();
  let processed = 0;
  let skipped = 0;
  let vaultAdded = 0;
  const bump = (name) => {
    if (!byDest.has(name)) byDest.set(name, { name, processed: 0, skipped: 0, vaultAdded: 0 });
    return byDest.get(name);
  };
  for (const s of snapshots) {
    for (const x of s.processed) { processed++; bump(x.name).processed++; }
    for (const x of s.skipped) { skipped++; bump(x.name).skipped++; }
    vaultAdded += s.vaultAdded;
  }
  if (cfg.apply) {
    for (const s of snapshots) for (const x of s.processed) if (x.sha) bump(x.name).vaultAdded++;
  }

  return {
    apply: !!cfg.apply,
    root,
    vaultRoot,
    snapshotsScanned: dirs.length,
    snapshotsTouched: snapshots.length,
    processed,
    skipped,
    vaultAdded,
    byDest: [...byDest.values()].sort((a, b) => a.name.localeCompare(b.name)),
    details: snapshots.map((s) => ({
      dir: s.dir,
      processed: s.processed.map((x) => ({ name: x.name, bytes: x.bytes })),
      skipped: s.skipped,
    })),
  };
}

/** 人类可读报告。 */
export function format(report) {
  const lines = [];
  lines.push(`redact-existing: ${report.apply ? 'apply' : 'dry-run'} · 扫描 ${report.snapshotsScanned} 个快照，命中 ${report.snapshotsTouched} 个`);
  if (report.byDest.length === 0) {
    lines.push('  无敏感文件命中（快照内既无明文，也无已脱敏项）。');
    return lines;
  }
  for (const d of report.byDest) {
    const parts = [];
    if (d.processed > 0) parts.push(`${report.apply ? '处理' : '待处理'} ${d.processed}`);
    if (d.skipped > 0) parts.push(`跳过 ${d.skipped}`);
    if (d.vaultAdded > 0) parts.push(`vault 新增 ${d.vaultAdded}`);
    lines.push(`  ${d.name}: ${parts.join(' / ')}`);
  }
  lines.push(`  合计：${report.apply ? '处理' : '待处理'} ${report.processed}，跳过 ${report.skipped}，vault 新增 ${report.vaultAdded}`);
  if (!report.apply && report.processed > 0) lines.push('  默认只报告不写盘；确认无误后加 --apply 落盘。');
  if (report.processed > 0 || report.vaultAdded > 0) {
    lines.push('  提示：曾以明文落过盘的凭据应视为已泄露，建议轮换对应令牌与密钥。');
  }
  return lines;
}

// CLI 入口：仅当本文件被直接执行时运行，import 时不产生副作用。
const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1].replace(/\\/g, '/')}`)) : false;
if (invoked) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const cfg = buildConfig({ profileName: opt('--profile') ?? undefined });
  cfg.apply = argv.includes('--apply');
  const dir = opt('--dir');
  if (dir) {
    cfg.scanDir = dir;
    // 目录内自带 manifest.json 视为单个快照，否则视为快照仓库根。
    cfg.singleDir = await pathExists(join(dir, 'manifest.json'));
    if (cfg.singleDir) cfg.vaultRoot = dir;
  }
  const report = await run(cfg);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else for (const line of format(report)) console.log(line);
  process.exit(0);
}
