#!/usr/bin/env node
/**
 * 已解析著作登记脚本：扫描一个解析结果目录，提取元数据，写入「已解析著作/索引.md」
 * 用法：
 *   node index.mjs <书目录> [书名] [--offset N] [--tags "a,b"] [--info "备注"]
 * 示例：
 *   node index.mjs "D:\obsidian\vaults\学术笔记\已解析著作\艺术作品的本源" \
 *     "《艺术作品的本源》（海德格尔著，孙周兴译，商务印书馆2022版）" \
 *     --offset 8 --tags "海德格尔,现象学,艺术哲学,存在论" --info "扫描版 vlm+OCR；带《海德格尔全集》第5卷边码"
 * 说明：章节索引从 content_list.json 的标题块（text_level<=2 且文本短）提取，页码为 PDF 页（page_idx）。
 */
import fs from 'node:fs';
import path from 'node:path';

const INDEX_NAME = '索引.md';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`pdf2md-index — 已解析著作登记：扫描解析结果目录，写入图书馆索引
用法: node index.mjs <书目录> [书名] [选项]
选项:
  --library <根目录>   图书馆根目录（默认 ./library），索引写入 <根>/索引.md
  --offset N           PDF页→书页 偏移（书页 = PDF页 − N）
  --tags "a,b"         主题标签
  --info "备注"        自由备注
  -h, --help           显示本帮助`);
  process.exit(0);
}
const bookDir = args[0];
if (!bookDir || !fs.existsSync(bookDir)) {
  console.error('用法: node index.mjs <书目录> [书名] [--library 根目录] [--offset N] [--tags "a,b"] [--info "备注"]');
  process.exit(1);
}
let bookName = args[1] && !args[1].startsWith('--') ? args[1] : path.basename(bookDir);
let offset = 0, tags = '', info = '', library = 'library';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--offset') offset = parseInt(args[++i], 10) || 0;
  else if (args[i] === '--tags') tags = args[++i];
  else if (args[i] === '--info') info = args[++i];
  else if (args[i] === '--library') library = args[++i];
}
const INDEX_PATH = path.join(library, INDEX_NAME);

const fullMd = path.join(bookDir, 'full.md');
if (!fs.existsSync(fullMd)) {
  console.error('❌ 目录中未找到 full.md:', bookDir);
  process.exit(1);
}
const clFile = fs.readdirSync(bookDir).find((f) => f.endsWith('_content_list.json'));
if (!clFile) {
  console.error('❌ 目录中未找到 *_content_list.json，无法提取页码/章节');
  process.exit(1);
}

// 基本信息
const mdStat = fs.statSync(fullMd);
const mdBytes = mdStat.size;
const mdText = fs.readFileSync(fullMd, 'utf8');
const mdChars = mdText.length;
const dateStr = mdStat.mtime.toISOString().slice(0, 10);

// 页数与章节索引（content_list.json）
const cl = JSON.parse(fs.readFileSync(path.join(bookDir, clFile), 'utf8'));
let maxPage = 0;
const heads = [];
const walk = (items) => {
  for (const it of items) {
    if (typeof it.page_idx === 'number' && it.page_idx > maxPage) maxPage = it.page_idx;
    const t = (it.text || '').trim();
    // 标题块：层级浅 + 文本短 + 无句号结尾（避免把整段当标题）
    if (it.text_level !== undefined && it.text_level <= 2 && t.length > 0 && t.length <= 36 && !/。；：$/.test(t)) {
      heads.push({ page: it.page_idx, text: t });
    }
    if (it.children) walk(it.children);
  }
};
walk(cl);
const pdfPages = maxPage + 1;

// 组装条目
const lines = [];
lines.push(`## ${bookName}`);
const relMd = path.relative(library, fullMd).split(path.sep).join('/');
const metaBits = [`解析日期：${dateStr}`, `full.md：\`${relMd}\`（${(mdBytes / 1024).toFixed(0)}KB ≈ ${(mdChars / 1000).toFixed(0)}千字 ≈ ${Math.round((mdChars * 1.2) / 1000)}K token）`];
lines.push(`- ${metaBits.join('｜')}`);
lines.push(`- PDF 页数：${pdfPages}${offset ? `｜页码换算：书页 = PDF 页 − ${offset}` : ''}`);
if (tags) lines.push(`- 主题标签：#${tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).join(' #')}`);
if (info) lines.push(`- 备注：${info}`);
if (heads.length) {
  lines.push('- 章节索引：');
  for (const h of heads.slice(0, 30)) {
    const pageLabel = offset ? `书页~${h.page - offset}` : `PDF p${h.page}`;
    lines.push(`  - ${pageLabel}｜${h.text.replace(/\s+/g, ' ')}`);
  }
  if (heads.length > 30) lines.push(`  - …（共 ${heads.length} 个标题块）`);
}
lines.push('');

const entry = lines.join('\n');

// 写入/更新索引.md（同名条目替换）
let idx = '';
if (fs.existsSync(INDEX_PATH)) idx = fs.readFileSync(INDEX_PATH, 'utf8');
if (!idx.includes('# 已解析著作目录')) {
  idx = `# 已解析著作目录（维柯 PDF 图书馆）

> 找书：先读本索引确定书目（约 1–2K token），再读对应 full.md；或直接 grep 本文件夹全文（零 token）。
> 页码换算：MinerU 输出 PDF 页码（page_idx 从 0 起）；书页 = PDF 页 − 偏移（见各条目）。

---
`;
}
// 去掉与目标书名同名的旧条目块
const blocks = idx.split(/(?=^## )/m);
const kept = blocks.filter((b) => !b.startsWith(`## ${bookName}`));
const out = kept.join('').replace(/\n+$/, '\n') + '\n' + entry;
fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
fs.writeFileSync(INDEX_PATH, out, 'utf8');

console.log('✅ 已登记:', bookName);
console.log('   索引文件:', INDEX_PATH);
console.log(`   页数 ${pdfPages}｜章节标题块 ${heads.length} 个`);
