// make-v4-session.mjs — 会话格式 v4 实文件夹具生成器（v0.5.0，W44）
//
// 用途：为 smoke-test 与离线排查产出真实可解码的 zstd 会话日志，覆盖 v0 / v2 / v3 /
// v4 四代命名与单帧布局违规样本（8 月 18 日崩溃的根因形态）。帧结构与 zstd 帧布局
// 与真实 DSH 产物同形，故 undo_scan / sessionCensus / session-scan.mjs 可原样消费。
//
// v4 相对 v3 的语义差异（DSH 0.2.0，SESSION_FORMAT_VERSION 3 到 4）：持久层零 diff，
// 帧结构与 zstd 帧布局未变；变更在会话头语义——系统提示词随会话落盘，并带 PTC
// 迁移产物字段（取自批次合集的 v4 描述）。本生成器把这两点落成头行的
// systemPrompt 字段与 ptc 对象，事件流的行格式与 seq 规则与 v3 完全一致。
// 该字段位置对被测链路是关键：系统提示词随头落盘，才使 v4 成为「脱敏必须覆盖
// 会话头」的第一个代际（v0 至 v3 的头行不含文本内容）。
//
// 用法：
//   node tools/make-v4-session.mjs <目标目录> [--variant native|seeded|single-frame|mixed]
//
// 各变体在目标目录下产出的结构（一个会话一个子目录，与真实 sessions/ 布局一致）：
//   native        <目标>/sess-v4/session.v4.jsonl.zstd
//   seeded        <目标>/sess-v4-seeded/session.v4.jsonl.zstd（seeded 迁移形态，seq 从 5 起）
//   single-frame  <目标>/sess-v4-single-frame/session.jsonl.zstd（单帧违规）
//   mixed         上述三个 + sess-v0 / sess-v2 / sess-v3，一次备齐四代加违规样本
//
// 零依赖：只用 node:fs / node:path / node:zlib。zstd Zlib API 需 Node 22.15 以上；
// 低于该版本时脚本明确报错并给出可行替代，不静默生成坏夹具。
//
// @module dsh-undo-savepoint/make-v4-session

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;
const MIN_NODE = [22, 15];

/** v4 夹具内嵌的明文标记：用于验证脱敏链路的入口位置，非真实凭据。 */
const PLAINTEXT_MARKER = 'sk-fixture-v4-session-0123456789abcdef';

const VARIANTS = ['native', 'seeded', 'single-frame', 'mixed'];

function nodeTooOld() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1]);
}

function assertZstd() {
  if (!zstdCompressSync) {
    const e = new Error(
      `make-v4-session requires Node.js >= ${MIN_NODE.join('.')} (node:zlib zstd API not available on ${process.version}). `
      + 'Alternative on older Node: skip this generator and treat the v4 fixtures as unavailable, or upgrade Node.',
    );
    e.code = 'ZSTD_UNSUPPORTED';
    throw e;
  }
}

function compress(text) {
  assertZstd();
  return zstdCompressSync(Buffer.from(text, 'utf8'));
}

function jsonLine(value) {
  return JSON.stringify(value) + '\n';
}

/**
 * 构造一帧 zstd 布局的会话日志字节。
 * frames = [头帧文本, 事件帧文本...]；singleFrame = true 时把头帧与事件帧并入一帧
 * （单帧布局违规形态），专供 undo_scan 的 fixable 判定使用。
 */
function buildSession(options = {}) {
  const {
    generation = 4,
    id = `fixture-v${generation}`,
    systemPrompt = PLAINTEXT_MARKER,
    seeded = false,
    singleFrame = false,
    events = null,
    extraHeader = null,
    dropHeaderField = null,
  } = options;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new Error(`generation must be a non-negative integer, got ${generation}`);
  }
  const defaultEvents = [
    jsonLine({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    jsonLine({
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: { turn: 1, texts: ['fixture reply'] },
    }),
    jsonLine({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
  ];
  const eventLines = (events ?? defaultEvents).join('');
  const header = {
    type: 'session',
    version: generation,
    id,
    createdAt: 1757500000 + generation,
    isSeeded: seeded,
    delegationDepth: 0,
  };
  const v4 = generation >= 4;
  if (v4) {
    // v4 语义一：系统提示词随会话落盘（PTC 迁移产物形态）。
    header.systemPrompt = systemPrompt;
    header.ptc = { migratedFrom: 3, promptSource: 'context', materialized: true };
  }
  if (extraHeader) Object.assign(header, extraHeader);
  if (dropHeaderField) delete header[dropHeaderField];
  const headerText = jsonLine(header);
  if (singleFrame) return compress(headerText + eventLines);
  return Buffer.concat([compress(headerText), compress(eventLines)]);
}

/** 生成器产出的样本清单（供断言与 CLI 摘要共用，避免两处各写一遍文件名）。
 * 会话目录名各带代际后缀，故同一目标目录下六个样本互不重名——walkSessionFiles
 * 按目录取最高代，重名会让两个样本折叠成一个会话，断言计数随之漂移。 */
function sampleSpecs() {
  return [
    { dir: 'sess-v0', file: 'session.jsonl.zstd', generation: 0, variant: 'native' },
    { dir: 'sess-v2', file: 'session.v2.jsonl.zstd', generation: 2, variant: 'native' },
    { dir: 'sess-v3', file: 'session.v3.jsonl.zstd', generation: 3, variant: 'native' },
    { dir: 'sess-v4-native', file: 'session.v4.jsonl.zstd', generation: 4, variant: 'native' },
    { dir: 'sess-v4-seeded', file: 'session.v4.jsonl.zstd', generation: 4, variant: 'seeded' },
    { dir: 'sess-v4-single-frame', file: 'session.v4.jsonl.zstd', generation: 4, variant: 'single-frame' },
  ];
}

/**
 * 写单个变体到 <target>。
 * @returns {Promise<{target: string, variant: string, written: string[]}>}
 */
async function writeVariant(target, variant = 'native') {
  if (!VARIANTS.includes(variant)) {
    throw new Error(`unknown variant ${variant}; expected one of ${VARIANTS.join('|')}`);
  }
  if (variant === 'mixed') return writeMixed(target);
  assertZstd();
  const written = [];
  const put = async (dir, file, buf) => {
    await mkdir(join(target, dir), { recursive: true });
    await writeFile(join(target, dir, file), buf);
    written.push(`${dir}/${file}`);
  };
  if (variant === 'native') {
    await put('sess-v4-native', 'session.v4.jsonl.zstd', buildSession({ generation: 4, id: 'fixture-v4-native' }));
  } else if (variant === 'seeded') {
    // seeded 迁移形态：头 isSeeded=true，事件流首行 session/end-seed 的 seq 为
    // inheritedEventCount（不从 0 起），其后严格连续。v0.4.7 的锚定逻辑认这一形态。
    const events = [
      jsonLine({ type: 'session/end-seed', seq: 5, time: 10, data: { inherited: true } }),
      jsonLine({ type: 'turn/start', seq: 6, time: 11, data: { turn: 2 } }),
      jsonLine({ type: 'turn/end', seq: 7, time: 12, data: { turn: 2, reason: { kind: 'completed' } } }),
    ];
    await put('sess-v4-seeded', 'session.v4.jsonl.zstd', buildSession({
      generation: 4, id: 'fixture-v4-seeded', seeded: true, events,
    }));
  } else if (variant === 'single-frame') {
    await put('sess-v4-single-frame', 'session.v4.jsonl.zstd', buildSession({
      generation: 4, id: 'fixture-v4-single-frame', singleFrame: true,
    }));
  }
  return { target, variant, written };
}

/** 一次备齐 v0 / v2 / v3 / v4 四代加 seeded 与单帧违规样本。
 * 保留会话目录名 sess-v0 / sess-v2 / sess-v3 / sess-v4-native / sess-v4-seeded /
 * sess-v4-single-frame（与 sampleSpecs 同源）。写入目标目录本身即当作 sessions 根，
 * 故校验调用方应传 <home>/sessions，或对生成结果直接用 undo_scan。 */
async function writeMixed(target) {
  assertZstd();
  const written = [];
  const put = async (dir, file, buf) => {
    await mkdir(join(target, dir), { recursive: true });
    await writeFile(join(target, dir, file), buf);
    written.push(`${dir}/${file}`);
  };
  for (const gen of [0, 2, 3]) {
    await put(`sess-v${gen}`, gen === 0 ? 'session.jsonl.zstd' : `session.v${gen}.jsonl.zstd`,
      buildSession({ generation: gen, id: `fixture-v${gen}` }));
  }
  const [nativeR, seededR, singleR] = [
    await writeVariant(target, 'native'),
    await writeVariant(target, 'seeded'),
    await writeVariant(target, 'single-frame'),
  ];
  for (const r of [nativeR, seededR, singleR]) written.push(...r.written);
  return { target, variant: 'mixed', written, specs: sampleSpecs() };
}

/** 在 <target>/<dir>/<file> 写一个「已修复形态」的两帧夹具（头帧 + 事件帧）。
 * 用途：E64 这类「修复后复扫应为 ok」的断言需要与病态单帧样本对照的已知良品，
 * 且不能复用 writeMixed 的产出（那会带进单帧违规样本，使 ok 计数不确定）。 */
async function writeTwoFrame(target, { dir, file, generation = 4, id = `fixture-v${generation}-ok` } = {}) {
  assertZstd();
  if (!dir || !file) throw new Error('writeTwoFrame requires { dir, file }');
  await mkdir(join(target, dir), { recursive: true });
  const bytes = buildSession({ generation, id });
  await writeFile(join(target, dir, file), bytes);
  return { target, dir, file, bytes };
}

function parseArgs(argv) {
  const out = { target: null, variant: 'native' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--variant') { out.variant = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    if (out.target === null) out.target = a;
    else throw new Error(`unexpected extra argument ${a}`);
  }
  return out;
}

const invoked = process.argv[1]
  ? fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1].replace(/\\/g, '/')}`))
  : false;

if (invoked) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`make-v4-session: ${error.message}`);
    process.exit(2);
  }
  if (args.help || args.target === null) {
    console.log('usage: node tools/make-v4-session.mjs <目标目录> [--variant native|seeded|single-frame|mixed]');
    process.exit(args.help ? 0 : 2);
  }
  if (nodeTooOld()) {
    console.error(`make-v4-session: Node ${process.version} 低于所需版本 ${MIN_NODE.join('.')}。`
      + '该系统上的替代做法：升级 Node 后重跑，或跳过本生成器并把 v4 会话用例按「无 zstd API」降级处理。');
    process.exit(2);
  }
  try {
    const r = await writeVariant(args.target, args.variant);
    console.log(`make-v4-session: variant=${r.variant} target=${r.target}`);
    for (const p of r.written) console.log(`  wrote ${p}`);
    console.log(`make-v4-session: ${r.written.length} file(s) ok`);
    process.exit(0);
  } catch (error) {
    console.error(`make-v4-session: ${String(error?.message ?? error)}`);
    process.exit(1);
  }
}

export {
  PLAINTEXT_MARKER,
  VARIANTS,
  buildSession,
  sampleSpecs,
  writeVariant,
  writeMixed,
  writeTwoFrame,
  nodeTooOld,
  parseArgs,
};
