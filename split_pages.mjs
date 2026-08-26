#!/usr/bin/env node
/**
 * 大 PDF 物理切片（用于文件超过 MinerU 200MB 限制的情况；页数限制由 parse 自动分片处理）
 * 用法：
 *   node split_pages.mjs <pdf路径> <输出目录> [每片页数，默认 200]
 * 示例：
 *   node split_pages.mjs "D:\书\大书.pdf" "D:\out" 200
 */
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

const args = process.argv.slice(2);
if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
  console.log('用法: node split_pages.mjs <pdf路径> <输出目录> [每片页数]');
  process.exit(0);
}
const [pdfPath, outDir] = args;
const per = parseInt(args[2], 10) || 200;
if (!fs.existsSync(pdfPath)) { console.error('❌ 文件不存在:', pdfPath); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const src = await PDFDocument.load(fs.readFileSync(pdfPath), { ignoreEncryption: true });
const total = src.getPageCount();
const n = Math.ceil(total / per);
console.log(`📄 ${path.basename(pdfPath)} (${total} 页) → ${n} 片（每片 ≤${per} 页）`);

for (let i = 0; i < n; i++) {
  const start = i * per;
  const end = Math.min((i + 1) * per, total);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, Array.from({ length: end - start }, (_, k) => start + k));
  pages.forEach((p) => out.addPage(p));
  const file = path.join(outDir, `part${i + 1}.pdf`);
  fs.writeFileSync(file, await out.save());
  console.log(`  ✅ part${i + 1}.pdf（页 ${start + 1}-${end}，${(fs.statSync(file).size / 1048576).toFixed(1)}MB）`);
}
console.log('切片完成');
