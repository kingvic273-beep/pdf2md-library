#!/usr/bin/env node
/**
 * 合并多批 MinerU 解析结果（页数超过 200 页时分批解析后合并）
 * 用法：
 *   node merge.mjs <书目录> <part目录:页偏移,part目录:页偏移,...>
 * 示例：
 *   node merge.mjs "library/书" "part1:0,part2:200"
 * 说明：full.md 按顺序拼接；content_list.json 合并且 page_idx 加偏移（还原全局 PDF 页码）。
 * 输出：书目录/full.md + 书目录/merged_content_list.json
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const bookDir = args[0];
const partSpec = args[1];
if (!bookDir || !partSpec) {
  console.error('用法: node merge.mjs <书目录> <part目录:页偏移,part目录:页偏移,...>');
  process.exit(1);
}
const parts = partSpec.split(',').map((s) => {
  const [dir, off] = s.split(':');
  return { dir: path.resolve(bookDir, dir), offset: parseInt(off, 10) || 0 };
});

let fullMd = '';
const mergedCl = [];
let fullMdLen = 0;

for (const p of parts) {
  const mdPath = path.join(p.dir, 'full.md');
  if (!fs.existsSync(mdPath)) {
    console.error(`❌ 缺少 ${mdPath}`);
    process.exit(1);
  }
  fullMd += fs.readFileSync(mdPath, 'utf8') + '\n\n';
  fullMdLen += fs.statSync(mdPath).size;

  const clFile = fs.readdirSync(p.dir).find((f) => f.endsWith('_content_list.json'));
  if (!clFile) {
    console.error(`❌ ${p.dir} 缺少 content_list.json`);
    process.exit(1);
  }
  const cl = JSON.parse(fs.readFileSync(path.join(p.dir, clFile), 'utf8'));
  const shift = (items) => {
    for (const it of items) {
      if (typeof it.page_idx === 'number') it.page_idx += p.offset;
      if (it.children) shift(it.children);
    }
  };
  shift(cl);
  mergedCl.push(...cl);
  console.log(`  part ${path.basename(p.dir)}: offset ${p.offset}, cl blocks ${cl.length}`);
}

fs.writeFileSync(path.join(bookDir, 'full.md'), fullMd, 'utf8');
fs.writeFileSync(path.join(bookDir, 'merged_content_list.json'), JSON.stringify(mergedCl), 'utf8');
console.log('✅ 合并完成');
console.log(`   full.md: ${(fullMdLen / 1024).toFixed(0)}KB（${(fullMd.length / 1000).toFixed(0)} 千字）`);
console.log(`   content_list: ${mergedCl.length} 块 → ${path.join(bookDir, 'merged_content_list.json')}`);
