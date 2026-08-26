#!/usr/bin/env node
/**
 * PDF → Markdown 通用解析工具（MinerU Precision API，签名上传方式）
 * 用法：
 *   node parse.mjs <pdf路径> [选项]
 * 选项：
 *   --model vlm|pipeline   模型版本（默认 vlm，扫描件推荐）
 *   --no-ocr               关闭 OCR（仅对文字版 PDF）
 *   --lang ch|en           文档语言（默认 ch）
 *   --pages 1-20           只解析指定页码范围（如 "2,4-6"）
 *   --out <目录>           输出目录（默认 <pdf同目录>/<文件名>_mineru）
 * 输出：full.md（Markdown）、content_list.json（含 page_idx 页码映射）、layout.json、images/
 * 说明：解析不消耗 DeepSeek token；官方免费额度每天 1000 页优先，文件 ≤200MB、≤200 页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokenFile = path.join(__dirname, 'token.txt');
const token = process.env.MINERU_API_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
if (!token) {
  console.error('❌ 未配置 MinerU API Token：设置环境变量 MINERU_API_TOKEN，或在工具目录放 token.txt');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`pdf2md-parse — PDF → Markdown 解析（MinerU 官方 API）

用法: node parse.mjs <pdf路径> [选项]

选项:
  --model vlm|pipeline   模型版本（默认 vlm，扫描件推荐）
  --no-ocr               关闭 OCR（仅对文字版 PDF）
  --lang ch|en           文档语言（默认 ch）
  --pages 1-20           只解析指定页码范围（如 "2,4-6"）
  --out <目录>           输出目录（默认 <pdf同目录>/<文件名>_mineru）
  -h, --help             显示本帮助

Token: 环境变量 MINERU_API_TOKEN 或工具目录 token.txt（见 README）
额度: MinerU 官方免费，每天 1000 页优先，单文件 ≤200MB、≤200 页`);
  process.exit(args.length === 0 ? 1 : 0);
}

let model = 'vlm';
let isOcr = true;
let lang = 'ch';
let pageRanges;
let outDir;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--model') model = args[++i];
  else if (args[i] === '--no-ocr') isOcr = false;
  else if (args[i] === '--lang') lang = args[++i];
  else if (args[i] === '--pages') pageRanges = args[++i];
  else if (args[i] === '--out') outDir = args[++i];
}
if (!outDir) outDir = path.join(path.dirname(pdfPath), path.basename(pdfPath, path.extname(pdfPath)) + '_mineru');
fs.mkdirSync(outDir, { recursive: true });

const size = fs.statSync(pdfPath).size;
console.log(`📄 ${path.basename(pdfPath)} (${(size / 1048576).toFixed(1)}MB) → ${outDir}`);

// 1) 申请签名上传 URL
const files = [{ name: 'doc.pdf', is_ocr: isOcr }];
if (pageRanges) files[0].page_ranges = pageRanges;
const r1 = await fetch('https://mineru.net/api/v4/file-urls/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ files, model_version: model, enable_formula: true, enable_table: true, language: lang }),
});
const j1 = await r1.json();
if (!j1.data?.batch_id || !j1.data?.file_urls?.[0]) {
  console.error('❌ 提交失败:', JSON.stringify(j1).slice(0, 400));
  process.exit(1);
}
const batchId = j1.data.batch_id;
console.log('✅ 已提交，batch_id:', batchId);

// 2) PUT 上传文件到签名 URL
const buf = fs.readFileSync(pdfPath);
const r2 = await fetch(j1.data.file_urls[0], { method: 'PUT', body: buf });
if (r2.status >= 300) {
  console.error('❌ 上传失败 status:', r2.status);
  process.exit(1);
}
console.log('✅ 上传完成，等待解析…');

// 3) 轮询结果（15 分钟超时）
const deadline = Date.now() + 15 * 60 * 1000;
let first = null;
while (Date.now() < deadline) {
  const r3 = await fetch(`https://mineru.net/api/v4/extract-results/batch/${batchId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j3 = await r3.json();
  first = (j3.data?.extract_result ?? [])[0];
  if (first && (first.state === 'done' || first.state === 'failed')) break;
  console.log(`⏳ ${first?.state ?? '排队中'} ${first?.extract_progress ?? ''}`);
  await sleep(8000);
}
if (!first || first.state !== 'done') {
  console.error('❌ 任务未完成:', JSON.stringify({ state: first?.state, err: first?.err_msg }));
  process.exit(1);
}
console.log('✅ 解析完成，下载结果…');

// 4) 下载 zip 并解压到输出目录
const zipRes = await fetch(first.full_zip_url);
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
const tmpZip = path.join(outDir, '_result.zip');
fs.writeFileSync(tmpZip, zipBuf);
const zip = new AdmZip(tmpZip);
zip.extractAllTo(outDir, true);
fs.rmSync(tmpZip);

const fullMd = path.join(outDir, 'full.md');
if (!fs.existsSync(fullMd)) {
  console.error('❌ 未找到 full.md，请检查输出目录');
  process.exit(1);
}
const mdBytes = fs.statSync(fullMd).size;
const mdChars = fs.readFileSync(fullMd, 'utf8').length;
console.log('──────────────────────────────');
console.log(`✅ full.md: ${fullMd}`);
console.log(`   大小 ${(mdBytes / 1024).toFixed(0)}KB ≈ ${Math.round(mdChars / 1000)} 千字`);
console.log(`   token 粗估（中文 ~1.2 token/字）: ${Math.round((mdChars * 1.2) / 1000)}K token（分章读可更省）`);
console.log(`   检索: node search.mjs "${outDir}" 关键词 [--offset 偏移]`);
