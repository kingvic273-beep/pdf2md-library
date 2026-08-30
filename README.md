# pdf2md-library — 学术 PDF 图书馆

把扫描版/任意 PDF 变成可检索的 Markdown，并建立"图书馆索引"，让文本模型（如 DeepSeek Harness / 各类 Agent）用**少量 token** 阅读书籍、检索内容、定位页码。

面向学术场景设计：解析 → 归档 → 索引（含**页码换算与章节导航**）→ 按需检索。

## 特性

- **扫描版可读**：基于 [MinerU](https://mineru.net) 官方 API（opendatalab），vlm 模型 + OCR，192 页扫描版也能全书转 Markdown；
- **超长书自动分片**：>200 页的 PDF 自动按 200 页/片分批解析、自动合并（无需手动分批），输出全局页码；
- **超 200MB 自动物理切片**：文件超出 MinerU 单文件大小上限时自动按 200 页/片切文件再解析合并（上限可用环境变量 `PDF2MD_MAX_FILE_MB` 覆盖）；
- **流式上传**：上传不把整个文件读入内存，大文件/并发更稳（避免 OOM/ENOBUFS）；
- **图书馆索引**：每本书自动登记（解析日期 / token 量 / 页码换算 / 主题标签 / 章节索引），找书先读索引（~1–2K token）；
- **页码注入**：解析后自动在 `full.md` 每页首插入 `<!-- PDF pN -->` 标记，并**自动校准页边码**（扫描页脚数字序列算出偏移），标注 `<!-- PDF pN / 书页 pM -->`，读全文即可定位页码，检索、引用零成本；
- **页码换算**：MinerU 输出 PDF 页码，`--offset` 一键换算为书页/边码，可直接用于论文引用；
- **token 经济**：解析阶段 0 token（MinerU 云端免费额度）；读取阶段中文约 1–1.5 token/字，`full.md` 落盘后可跨会话复用；
- **官方免费**：mineru.net 明确"暂无商业化收费计划"，每账号每天 1000 页最高优先级。

## 工作原理

直接调用 MinerU **精准解析 API**（"签名 URL 上传"流程）：

1. `POST /api/v4/file-urls/batch` 申请签名上传地址；
2. `PUT` 上传本地文件；
3. 轮询 `GET /api/v4/extract-results/batch/{batchId}` 直到完成；
4. 下载 zip 解压出 `full.md`（含 `content_list.json` 页码映射）。

不依赖任何 DSH 插件；脚本可直接用于 CLI，也可由 Agent 调用。

## 安装

```bash
git clone https://github.com/kingvic273-beep/pdf2md-library.git
cd pdf2md-library
npm install          # 安装 adm-zip
```

也可作为 npm CLI 全局安装（发布后）：
```bash
npm install -g pdf2md-library
```

## 快速开始

**0. 配置 Token**（[mineru.net](https://mineru.net) 注册后，在 API 管理页创建）：

```bash
export MINERU_API_TOKEN="sk-xxxx"        # 或写入工具目录 token.txt（被 .gitignore 排除）
```

**1. 解析一本书**：

```bash
node parse.mjs "论文.pdf"                          # 默认 vlm + OCR + 中文；自动校准页边码并注入书页
node parse.mjs "扫描书.pdf" --pages 1-100 --out "书_mineru"
node parse.mjs "书.pdf" --offset 8                 # 手动指定偏移（书页=PDF页−8），跳过自动校准
node parse.mjs "书.pdf" --auto-offset              # 强制自动校准页边码偏移
```

输出目录（默认 `<pdf同目录>/<文件名>_mineru/`）：
| 文件 | 用途 |
|---|---|
| `full.md` | 全书 Markdown，**每页首自动插入 `<!-- PDF pN -->` 页码标记**（`--no-page-marks` 关闭） |
| `*_content_list.json` | 分块文本 + `page_idx`（页码映射） |
| `layout.json` | 版面信息 |
| `images/` | 提取的图片 |

**2. 归档并登记进图书馆**：

```bash
mkdir -p library/我的书
cp 书_mineru/full.md 书_mineru/*.json library/我的书/
node index.mjs "library/我的书" "《我的书》（作者，版本）" \
  --tags "海德格尔,现象学" --info "扫描版 vlm+OCR"
```

（页码偏移已由 parse 自动校准注入；`index.mjs` 的 `--offset` 仅用于无页码标记的旧书。）

**3. 检索内容**（无 `--offset` 时自动校准书页）：

```bash
node search.mjs "library/我的书" "本质现身" "Wesen"
# [书页~34] Wesen: 后期海德格尔经常把德文名词"本质"（das Wesen）作动词化处理……
node search.mjs "library/我的书" "本源" --offset 8   # 或手动指定
node search.mjs "library/我的书" "本源" --raw        # 显示 PDF 页（跳过校准）
```

**4. Agent 找书闭环**（token 经济）：

1. 读 `library/索引.md`（~1–2K token）确定书目与页码换算；
2. 或 `grep` 整个 library 全文搜索（零 token）；
3. 只读目标书对应章节片段（几千–2 万 token）。

## 命令一览

| 命令 | 功能 |
|---|---|
| `pdf2md-parse <pdf> [选项]` | PDF → Markdown（`--model --no-ocr --lang --pages --out --offset --auto-offset --no-page-marks`；**>200 页自动分片、>200MB 自动物理切片、自动校准页边码**） |
| `pdf2md-search <目录> <关键词...> [--offset N] [--raw]` | 检索 + 页码换算（无 `--offset` 时自动校准） |
| `pdf2md-index <书目录> [书名] [--library 根] [--offset N] [--tags] [--info]` | 登记图书馆索引 |
| `pdf2md-merge <书目录> <part:偏移,...>` | 手动合并多批解析结果（一般无需使用，parse 已自动合并） |
| `pdf2md-pagemarks <目录> [--offset N|--auto-offset]` | 给旧版解析结果补注页码 |

## 额度与成本

- **解析**：0 DeepSeek token；MinerU 官方免费（每天 1000 页最高优先级，单文件 ≤200MB、≤200 页）；
- **读取**：full.md 中文约 1–1.5 token/字；整本 200 页书 ≈ 10–20 万 token 全读，按章/片段读每次几千–2 万 token；
- 每本书只解析一次，`full.md` 永久复用。

## 常见问题

- **`--pages` 怎么写**？`"2,4-6"` = 第 2 页 + 第 4–6 页；`"2--2"` = 第 2 页到倒数第 2 页。
- **页码对不上**？parse 已自动校准页边码（扫描页脚 `page_number` 数字序列，需连续 ≥5 页才采信）；若仍不准，按目录页算偏移后手动 `--offset N`。旧版解析的书可 `node pagemarks.mjs <目录> --auto-offset` 单独补注。
- **自动校准的原理**？MinerU 会把页脚页码识别为 `type: page_number` 的纯数字块；取连续 ≥5 页、数字等差为 1 且 (PDF页−数字) 恒定的最长序列，差值即 offset（实测英伽登书=0、《艺术作品的本源》=8）。
- **能解析 docx/图片吗**？MinerU 支持，本工具目前聚焦 PDF；欢迎 PR。

## 免责声明

- 工具本身为通用文档解析；请确保解析内容符合版权与相关法规；
- MinerU API 条款与免费额度以其官网为准；
- Token 属敏感凭证，请勿提交到公开仓库。

## 路线图

- [ ] 一键"解析+归档+登记"组合命令；
- [ ] 批量解析；
- [ ] 章节级摘要索引（进一步降低找书成本）；
- [ ] 导出引用格式（脚注页码自动标注）。

## 许可证

MIT © 2026 kingvic273-beep
