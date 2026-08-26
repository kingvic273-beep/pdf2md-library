#!/usr/bin/env node
/**
 * 在 MinerU 解析结果中检索关键词（用 content_list.json 的 page_idx 映射页码）
 * 用法：
 *   node search.mjs <结果目录> <关键词...> [--offset N]
 *   --offset N：PDF页码 - N = 书页/边码页码（每本书偏移不同，先按目录校准一次）
 * 示例：
 *   node search.mjs "D:\书\书_mineru" "本质现身" "Wesen"
 *   node search.mjs "D:\书\书_mineru" "本源" --offset 8   # PDF p42 → 书页 34
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node search.mjs <结果目录> <关键词...> [--offset N]');
  process.exit(1);
}
const kws = args.filter((a) => !a.startsWith('--'));
let offset = 0;
const oi = args.indexOf('--offset');
if (oi !== -1) offset = parseInt(args[oi + 1], 10) || 0;

const clFile = fs.readdirSync(dir).find((f) => f.endsWith('_content_list.json'));
if (!clFile) {
  console.error('❌ 结果目录中未找到 *_content_list.json');
  process.exit(1);
}
const cl = JSON.parse(fs.readFileSync(path.join(dir, clFile), 'utf8'));

const hits = [];
const walk = (items) => {
  for (const it of items) {
    const t = it.text || '';
    const pg = it.page_idx;
    for (const kw of kws) {
      let p = t.indexOf(kw);
      while (p !== -1) {
        hits.push({ pg, kw, ctx: t.slice(Math.max(0, p - 30), p + 55).replace(/\s+/g, ' ') });
        p = t.indexOf(kw, p + 1);
      }
    }
    if (it.children) walk(it.children);
  }
};
walk(cl);

if (!hits.length) {
  console.log('无命中');
  process.exit(0);
}
for (const h of hits) {
  const pageLabel = offset ? `书页~${h.pg - offset}` : `PDF页${h.pg}`;
  console.log(`[${pageLabel}] ${h.kw}: ${h.ctx}`);
}
console.log(`共 ${hits.length} 处命中`);
