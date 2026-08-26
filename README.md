# pdf2md-library — 学术 PDF 图书馆

把扫描版/任意 PDF 变成可检索的 Markdown，并建立"图书馆索引"，让文本模型（如 DeepSeek Harness / 各类 Agent）用**少量 token** 阅读书籍、检索内容、定位页码。

面向学术场景设计：解析 → 归档 → 索引（含**页码换算与章节导航**）→ 按需检索。

## 特性

- **扫描版可读**：基于 [MinerU](https://mineru.net) 官方 API（opendatalab），vlm 模型 + OCR，192 页扫描版也能全书转 Markdown；
- **图书馆索引**：每本书自动登记（解析日期 / token 量 / 页码换算 / 主题标签 / 章节索引），找书先读索引（~1–2K token）；
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
