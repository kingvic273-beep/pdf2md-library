#!/usr/bin/env node
/**
 * PDF → Markdown 通用解析工具（MinerU Precision API，签名上传方式）
 * 用法：
 *   node parse.mjs <pdf路径> [选项]
 * 选项：
 *   --model vlm|pipeline   模型版本（默认 vlm，扫描件推荐）
 *   --no-ocr               关闭 OCR（仅对文字版 PDF）
 *   --lang ch|en           文档语言（默认 ch）
 *   --pages 1-20           手动指定页码范围（如 "2,4-6"）；指定后不做自动分片
 *   --out <目录>           输出目录（默认 <pdf同目录>/<文件名>_mineru）
 *   -h, --help             显示本帮助
 * 特性：
 *   - 自动分片：>200 页的 PDF 自动按 200 页/片分批解析、合并（full.md + merged_content_list.json）
 *   - 自动物理切片：文件 >200MB（可设 PDF2MD_MAX_FILE_MB 覆盖）时先按 200 页/片切文件再解析合并
 *   - 流式上传：上传不占整文件内存（ENOBUFS/大文件友好）
 *   - 页码映射：merged_content_list.json 的 page_idx 为全局 PDF 页码
 * 说明：解析不消耗 DeepSeek token；官方免费额度每天 1000 页优先，文件 ≤200MB。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH = 200; // MinerU 单次页数上限
const MAX_FILE_BYTES = (() => {
  const mb = Number(process.env.PDF2MD_MAX_FILE_MB || '200');
  return (Number.isFinite(mb) && mb > 0 ? mb : 200) * 1048576; // 单文件大小上限（可环境变量覆盖，便于测试）
})();

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
  --pages 1-20           手动指定页码范围（如 "2,4-6"）
  --out <目录>           输出目录（默认 <pdf同目录>/<文件名>_mineru）
  -h, --help             显示本帮助

特性: >200 页或 >200MB 的 PDF 自动分片/切片解析并合并（无需手动分批）
Token: 环境变量 MINERU_API_TOKEN 或工具目录 token.txt（见 README）
额度: MinerU 官方免费，每天 1000 页优先，单文件 ≤200MB`);
  process.exit(args.length === 0 ? 1 : 0);
}

const pdfPath = args[0];
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('用法: node parse.mjs <pdf路径> [选项]（--help 查看全部选项）');
  process.exit(1);
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
const buf = fs.readFileSync(pdfPath);

// 读取总页数（用于判断是否需要自动分片）
let totalPages = 0;
try {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  totalPages = src.getPageCount();
} catch (e) {
  console.warn('⚠️ 无法读取页数（pdf-lib 解析失败），按单批提交；若超 200 页将收到 MinerU 报错');
}
console.log(`📄 ${path.basename(pdfPath)} (${(size / 1048576).toFixed(1)}MB${totalPages ? `, ${totalPages} pages` : ''}) → ${outDir}`);

/** 提交一批：申请签名 URL → 流式 PUT → 轮询 → 下载解压到 partDir */
async function submitBatch(range, partDir, filePath = pdfPath) {
  fs.mkdirSync(partDir, { recursive: true });
  const files = [{ name: 'doc.pdf', is_ocr: isOcr }];
  if (range) files[0].page_ranges = range;
  const r1 = await fetch('https://mineru.net/api/v4/file-urls/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ files, model_version: model, enable_formula: true, enable_table: true, language: lang }),
  });
  const j1 = await r1.json();
  if (!j1.data?.batch_id || !j1.data?.file_urls?.[0]) {
    throw new Error('提交失败: ' + JSON.stringify(j1).slice(0, 300));
  }
  const batchId = j1.data.batch_id;

  // 流式上传：不把整个文件读入内存（大文件/并发友好）
  const r2 = await fetch(j1.data.file_urls[0], {
    method: 'PUT',
    headers: { 'Content-Length': String(fs.statSync(filePath).size) },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  if (r2.status >= 300) throw new Error(`上传失败 status: ${r2.status}`);

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
    throw new Error(`任务未完成: ${JSON.stringify({ state: first?.state, err: first?.err_msg })}`);
  }

  const zipRes = await fetch(first.full_zip_url);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const tmpZip = path.join(partDir, '_result.zip');
  fs.writeFileSync(tmpZip, zipBuf);
  const zip = new AdmZip(tmpZip);
  zip.extractAllTo(partDir, true);
  fs.rmSync(tmpZip);
}

/** 合并分片：full.md 拼接 + content_list page_idx 加偏移 */
function mergeParts(parts, destDir) {
  let fullMd = '';
  const mergedCl = [];
  for (const p of parts) {
    const mdPath = path.join(p.dir, 'full.md');
    if (!fs.existsSync(mdPath)) throw new Error(`缺少 ${mdPath}`);
    fullMd += fs.readFileSync(mdPath, 'utf8') + '\n\n';
    const clFile = fs.readdirSync(p.dir).find((f) => f.endsWith('_content_list.json'));
    if (!clFile) throw new Error(`${p.dir} 缺少 content_list.json`);
    const cl = JSON.parse(fs.readFileSync(path.join(p.dir, clFile), 'utf8'));
    const shift = (items) => {
      for (const it of items) {
        if (typeof it.page_idx === 'number') it.page_idx += p.offset;
        if (it.children) shift(it.children);
      }
    };
    shift(cl);
    mergedCl.push(...cl);
  }
  fs.writeFileSync(path.join(destDir, 'full.md'), fullMd, 'utf8');
  fs.writeFileSync(path.join(destDir, 'merged_content_list.json'), JSON.stringify(mergedCl), 'utf8');
  return { mdChars: fullMd.length, mdBytes: Buffer.byteLength(fullMd, 'utf8'), clBlocks: mergedCl.length };
}

// 主流程
if (size > MAX_FILE_BYTES) {
  // 物理切片路径：文件超大小上限（MinerU 拒收），先按 BATCH 页/片切文件，逐片单批解析，再合并
  console.log(`📦 文件 ${(size / 1048576).toFixed(1)}MB 超出单文件上限 ${Math.round(MAX_FILE_BYTES / 1048576)}MB，先物理切片（${BATCH} 页/片）…`);
  const physDir = path.join(outDir, '.phys');
  fs.mkdirSync(physDir, { recursive: true });
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const total = src.getPageCount();
  const n = Math.ceil(total / BATCH);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const start = i * BATCH;
    const end = Math.min((i + 1) * BATCH, total);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: end - start }, (_, k) => start + k));
    pages.forEach((p) => out.addPage(p));
    const slicePath = path.join(physDir, `part${i + 1}.pdf`);
    fs.writeFileSync(slicePath, await out.save());
    console.log(`\n── 物理切片 ${i + 1}/${n}（页 ${start + 1}-${end}，${(fs.statSync(slicePath).size / 1048576).toFixed(1)}MB）──`);
    const partDir = path.join(outDir, `.part${i + 1}`);
    await submitBatch(null, partDir, slicePath);
    parts.push({ dir: partDir, offset: i * BATCH });
    fs.rmSync(slicePath, { force: true });
  }
  fs.rmSync(physDir, { recursive: true, force: true });
  console.log('\n🧩 合并物理切片…');
  const merged = mergeParts(parts, outDir);
  for (const p of parts) fs.rmSync(p.dir, { recursive: true, force: true });
  console.log(`✅ 合并完成: ${outDir}/full.md + merged_content_list.json（${merged.clBlocks} 块）`);
  finalReport(outDir, merged.mdChars, merged.mdBytes);
} else if (pageRanges || totalPages <= BATCH) {
  // 单批（用户指定页码，或总页数未超限/未知）
  await submitBatch(pageRanges, outDir);
  const fullMd = path.join(outDir, 'full.md');
  if (fs.existsSync(fullMd)) {
    const mdBytes = fs.statSync(fullMd).size;
    const mdChars = fs.readFileSync(fullMd, 'utf8').length;
    finalReport(outDir, mdChars, mdBytes);
  }
} else {
  // 自动分片
  const nBatches = Math.ceil(totalPages / BATCH);
  console.log(`📑 ${totalPages} 页超出单次 ${BATCH} 页上限，自动分 ${nBatches} 片解析…`);
  const parts = [];
  for (let i = 0; i < nBatches; i++) {
    const start = i * BATCH + 1;
    const end = Math.min((i + 1) * BATCH, totalPages);
    console.log(`\n── 分片 ${i + 1}/${nBatches}（页 ${start}-${end}）──`);
    const partDir = path.join(outDir, `.part${i + 1}`);
    await submitBatch(`${start}-${end}`, partDir);
    parts.push({ dir: partDir, offset: i * BATCH });
  }
  console.log('\n🧩 合并分片…');
  const merged = mergeParts(parts, outDir);
  for (const p of parts) fs.rmSync(p.dir, { recursive: true, force: true });
  console.log(`✅ 合并完成: ${outDir}/full.md + merged_content_list.json（${merged.clBlocks} 块）`);
  finalReport(outDir, merged.mdChars, merged.mdBytes);
} 

function finalReport(dir, mdChars, mdBytes) {
  console.log('──────────────────────────────');
  console.log(`✅ full.md: ${path.join(dir, 'full.md')}`);
  console.log(`   大小 ${(mdBytes / 1024).toFixed(0)}KB ≈ ${Math.round(mdChars / 1000)} 千字`);
  console.log(`   token 粗估（中文 ~1.2 token/字）: ${Math.round((mdChars * 1.2) / 1000)}K token（分章读可更省）`);
  console.log(`   检索: node search.mjs "${dir}" 关键词 [--offset 偏移]`);
}
