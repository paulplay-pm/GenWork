# 通用工具脚本索引

这个文件记录 skill 开发过程中积累的通用脚本，避免每次重新手写相同逻辑。

## PDF 图片提取 → PNG

**文件**：`scripts/pdf_to_png.py`

**用途**：从图片类 PDF（招聘平台导出的简历，pypdf 提取返回乱码）提取嵌入图片并输出有效 PNG。

**特点**：
- 零外部依赖（仅 stdlib：struct + zlib）
- 直接读取 PDF XObject 的原始 RGB 数据
- 一行命令完成：`python pdf_to_png.py input.pdf output.png`
- 输出 PNG 可用 `read` 工具触发模型视觉 OCR

**使用场景**：A-S1 文本提取失败时的视觉 fallback。

---

## 高校排名按需查询

**文件**：`scripts/query_ranking.py`

**用途**：从 `university-ranking.md`（40K+ token）中按需查询单所或多所学校信息，避免全文加载。

**用法**：
```bash
python query_ranking.py university-ranking.md "中国人民大学"
python query_ranking.py university-ranking.md "哥伦比亚大学"
python query_ranking.py university-ranking.md "985列表"
```

**输出**：仅返回匹配的表格行（包含 985/211/双一流 标签、QS 排名、简称对照）。

**使用场景**：A-S2 高校归一化校验时需要确认学校层次和排名。

---

## 简历处理追踪（批量更新）

**文件**：`scripts/track_complete.py`

**用途**：一次调用同时更新 worklist + progress.md（5个A步骤） + A.log.md。

**特点**：
- 替代 5 次 `progress_manager.py --update` + 1 次 `worklist_manager.py --complete` + 1 次 `log_utils.py`
- 解决 PowerShell 不支持 `&&` 链式命令的问题
- 保持三层追踪文件的数据一致性

**用法**：
```bash
python track_complete.py /path/to/job-dir "张三.pdf" "82" "75" "985硕士,2段实习"
```

## 并行处理分组协调器

**文件**：`scripts/parallel_split.py`

**用途**：对大量简历启用并行处理时，将 worklist 拆分为 N 组，输出每个子 session 的 task prompt。

**特点**：
- 自动解析 worklist 中的待处理项
- 按组大小均分
- 输出可直接粘贴到 `sessions_spawn` 调用的 task 文本

**用法**：
```bash
python parallel_split.py /path/to/job-dir 5   # 分成5组
```

**使用场景**：Module A 处理 30+ 份简历时启用并行加速。结合子 session 并发处理。
