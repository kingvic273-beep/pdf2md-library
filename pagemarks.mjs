/**
 * pagemarks.mjs — 把页码注入 MinerU 解析结果（full.md）
 *
 * 背景：MinerU 返回的 full.md 是渲染后的 Markdown，本身不含页码；
 * 页码信息在 content_list.json 的 page_idx 字段里（分块级）。
 * 本模块利用"每页首个文本块"在 full.md 中顺序定位，在页首插入
 *   <!-- PDF p107 -->          （无 --offset）
 *   <!-- PDF p107 / 书页 p99 --> （有 --offset，书页 = PDF − offset）
 * 使读 full.md 即可定位页码，供论文引用 / Agent 检索。
 *
 * 用法（由 parse.mjs 调用）：
 *   import { injectPageMarks } from './pagemarks.mjs';
 *   injectPageMarks(outDir, { offset: 8 });
 *   // → 返回 { injected, failed, reason? }
 *
 * 也可作为 CLI 单独补注旧版解析结果（旧版 full.md 无页码标记）：
 *   node pagemarks.mjs <结果目录> [--offset N | --auto-offset]
 *   // 在 full.md 每页首插入 <!-- PDF pN -->（--offset/--auto-offset 时附书页）
 *
 * 自动校准（--auto-offset / detectOffset）：
 *   扫描 content_list 中"纯数字文本块"（多为页脚页边码），找连续 ≥5 页、
 *   数字等差为 1 且 PDF页−数字 恒定的最长序列，其差值即 offset（书页 = PDF页 − offset）。
 *   实测：英伽登书 → offset 0；《艺术作品的本源》→ offset 8。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 找到 content_list 文件：优先 merged_content_list.json（分片合并产物），否则任意 *_content_list.json */
export function findContentList(dir) {
  const merged = path.join(dir, 'merged_content_list.json');
  if (fs.existsSync(merged)) return merged;
  const f = fs.readdirSync(dir).find((x) => x.endsWith('_content_list.json'));
  return f ? path.join(dir, f) : null;
}

/** 收集"每页首个 text 块"：page_idx → 该页第一段正文（去空白），跳过页脚等非 text 类型 */
function collectPageFirstBlocks(cl) {
  const map = new Map();
  const walk = (items) => {
    for (const it of items) {
      const pg = it.page_idx;
      if (typeof pg === 'number' && it.type === 'text' && it.text && !map.has(pg)) {
        map.set(pg, it.text.replace(/\s+/g, ' ').trim());
      }
      if (it.children) walk(it.children);
    }
  };
  walk(cl);
  return map;
}

/**
 * 自动校准页边码偏移：书页 = PDF页 − offset。
 * 原理：页脚页边码常被识别为"纯数字文本块"（如 page_idx=9 的块文本是 "1"）。
 * 找连续 ≥5 页、数字等差为 1、且 (page_idx − 数字) 恒定的最长序列，差值即 offset。
 * @param {string} dir 结果目录（含 *_content_list.json）
 * @returns {{offset:number, pages:number, startPdf:number, startNum:number}|null}
 */
export function detectOffset(dir) {
  const clFile = findContentList(dir);
  if (!clFile) return null;
  let cl;
  try { cl = JSON.parse(fs.readFileSync(clFile, 'utf8')); } catch { return null; }

  // 收集 (page_idx, 纯数字) 候选块：type 为 page_number（页脚页码）优先，也兼容 text/footer
  const cands = [];
  const walk = (items) => {
    for (const it of items) {
      if (typeof it.page_idx === 'number' && it.text) {
        const t = String(it.text).trim();
        if (/^\d{1,4}$/.test(t)) {
          const type = it.type || '';
          if (type === 'page_number' || type === 'footer' || type === 'text') {
            cands.push({ pg: it.page_idx, num: parseInt(t, 10), type });
          }
        }
      }
      if (it.children) walk(it.children);
    }
  };
  walk(cl);
  if (cands.length < 5) return null;

  // 优先只看 page_number 类型（最可靠），若不足 5 个再放宽到 text/footer
  const byType = (t) => cands.filter((c) => c.type === t);
  let pool = byType('page_number');
  if (pool.length < 5) pool = cands;
  if (pool.length < 5) return null;

  // 排序后找最长连续段：pg 与 num 均严格递增、差 (pg−num) 恒定。
  // 注意：英文书左右页可能各识别出一个 page_number（如 pg8 同时有 4 和 5），
  // 因此允许多个候选来自同一 pg，只要 pg 与 num 分别单调递增即可成段。
  pool.sort((a, b) => (a.pg - b.pg) || (a.num - b.num));
  let best = null;
  let cur = null;
  for (const c of pool) {
    const diff = c.pg - c.num;
    if (cur && c.pg >= cur.endPg && c.num === cur.endNum + 1 && diff === cur.diff) {
      // pg 允许持平（同页多码）或递增，num 必须 +1 连续
      cur.len++;
      cur.endPg = c.pg;
      cur.endNum = c.num;
    } else {
      cur = { diff, len: 1, startPg: c.pg, startNum: c.num, endPg: c.pg, endNum: c.num };
    }
    if (!best || cur.len > best.len) best = cur;
  }
  if (!best || best.len < 5) return null; // 少于 5 页连续序列，不足为信
  return { offset: best.diff, pages: best.len, startPdf: best.startPg, startNum: best.startNum };
}

/**
 * 在 full.md 中按页插入页码标记。
 * @param {string} dir   结果目录（含 full.md 与 *_content_list.json）
 * @param {object} opts  { offset?: number }  书页 = PDF页 − offset
 * @returns {{injected:number, failed:number, reason?:string}}
 */
export function injectPageMarks(dir, { offset = 0 } = {}) {
  const clFile = findContentList(dir);
  if (!clFile) return { injected: 0, failed: 0, reason: 'no content_list' };
  const mdPath = path.join(dir, 'full.md');
  if (!fs.existsSync(mdPath)) return { injected: 0, failed: 0, reason: 'no full.md' };

  const cl = JSON.parse(fs.readFileSync(clFile, 'utf8'));
  const pages = collectPageFirstBlocks(cl);
  let md = fs.readFileSync(mdPath, 'utf8');

  // 幂等性：若文件已含页码标记（上次注入残留），先剥离再重新注入
  if (md.includes('<!-- PDF p')) {
    md = md.replace(/^<!-- PDF p.*? -->\n(?:[ \t]*\n)?/gm, '');
  }

  // 归一化全文（去空白），在归一化文本上定位页首块；同时按行建立映射：
  //   normLines 与 mdLines 行数一一对应（归一化不增删行），用行号在原始 md 中定位行首
  const mdLines = md.split('\n');
  const norm = mdLines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');

  const pgs = [...pages.keys()].sort((a, b) => a - b);
  let cursor = 0;
  let injected = 0;
  let failed = 0;
  const inserts = []; // { line: 原始md行号, label }

  for (const pg of pgs) {
    const frag = pages.get(pg);
    // needle 取页首块前 200 字符：足够长以区分"多页共享同一起始文本"（如封面/扉页/版权页都印书名）
    const needle = frag.slice(0, 200);
    const idx = norm.indexOf(needle, cursor);
    if (idx === -1) { failed++; continue; }
    // 找到 idx 所在行号（在 norm 中，与原始 md 行号一致）
    const lineNo = norm.slice(0, idx).split('\n').length - 1;
    const label = offset ? `PDF p${pg} / 书页 p${pg - offset}` : `PDF p${pg}`;
    inserts.push({ line: lineNo, label });
    // cursor 推进到该页首块全文之后（而非 needle 尾），避免同页多块/共享文本错位
    cursor = idx + Math.max(frag.length, needle.length);
    injected++;
  }

  if (inserts.length) {
    // 按行号从后往前插入，避免位移影响后续行号
    inserts.sort((a, b) => b.line - a.line);
    const lines = [...mdLines];
    for (const ins of inserts) {
      const mark = `<!-- ${ins.label} -->`;
      lines.splice(ins.line, 0, mark, '');
    }
    fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
  }
  return { injected, failed };
}

// CLI 入口：node pagemarks.mjs <结果目录> [--offset N | --auto-offset]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (!args[0] || args.includes('-h') || args.includes('--help')) {
    console.log('pagemarks — 给 MinerU 解析结果补注页码\n\n用法: node pagemarks.mjs <结果目录> [--offset N | --auto-offset]\n示例: node pagemarks.mjs "D:\\书\\书_mineru" --offset 8\n      node pagemarks.mjs "D:\\书\\书_mineru" --auto-offset   # 自动检测页边码偏移');
    process.exit(args.length === 0 ? 1 : 0);
  }
  const dir = args[0];
  if (!fs.existsSync(dir)) { console.error('目录不存在: ' + dir); process.exit(1); }
  let offset = 0;
  const oi = args.indexOf('--offset');
  if (oi !== -1) {
    offset = parseInt(args[oi + 1], 10) || 0;
  } else if (args.includes('--auto-offset')) {
    const det = detectOffset(dir);
    if (!det) {
      console.error('❌ 自动校准失败：未找到连续 ≥5 页的页边码数字序列；请手动 --offset N');
      process.exit(1);
    }
    offset = det.offset;
    console.log(`🔢 自动校准: 连续 ${det.pages} 页页边码（PDF p${det.startPdf}=书页${det.startNum}），offset=${det.offset}`);
  }
  const r = injectPageMarks(dir, { offset });
  if (r.reason) { console.error('❌ ' + r.reason); process.exit(1); }
  console.log(`✅ 页码注入完成: 成功 ${r.injected} 页${r.failed ? `，${r.failed} 页未定位` : ''}（${path.join(dir, 'full.md')}）`);
}
