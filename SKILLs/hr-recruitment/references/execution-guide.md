# Execution Guide — Operational Reference

This document contains operational details for running Module A: the worklist-driven execution loop, shell compatibility, context management, progress reporting rules, and visual fallback procedures.

## Sequential Execution Model

Module A processes resumes **one at a time, sequentially**. Each resume is an **atomic, independent unit** — processing one resume does not require context from any other resume (except the JD/comprehensive-requirements). This design supports batches of 100+ resumes without context overflow.

### The Worklist

The worklist (`A-parse/A.worklist.md`) is a compact markdown table that tracks per-resume status. It is the **primary driver for sequential execution**.

```markdown
# Module A 简历处理进度表

- 总数:78
- 已完成:23
- 失败:1
- 跳过:2
- 待处理:52
- 最后更新:2026-05-14 10:30

| # | 状态 | 文件名 | 质量分 | 可信度 | 备注 |
|---|------|--------|--------|--------|------|
| 1 | ✅ | 张三.pdf | 82 | 75 | 985硕士,2段实习 |
| 2 | ✅ | 李四.docx | 65 | 88 | 普通本科 |
| 3 | ❌ | 王五.png | - | - | 图片PDF无法提取 |
| 4 | ⏳ | 赵六.pdf | - | - | - |
| ... | ... | ... | ... | ... | ... |
```

### Execution Loop (Per Resume)

```
LOOP:
  1. Run: worklist_manager.py --next → get filename (or "ALL_DONE")
  2. If ALL_DONE → post-processing (dedup, summary, alerts) → report to HR → STOP
  3. A-S1 文本提取 + 代码写入原始文本节：
     - PDF → pypdf；若 pypdf 失败：模型具备多模态能力 → read 原始 PDF；否则 → mark ❌
     - DOCX → python-docx
     - 独立图片文件(JPG/PNG) → read 工具送入模型视觉
     - 严禁本地 OCR / 严禁 PDF 转图片（任何情况）
     - 提取成功 → Python 代码写入 analysis.md 原始文本节
     - If extraction fails → worklist_manager.py --fail → NEXT
  4. A-S2～A-S5 分析（LLM 精析，禁止脚本）：
     - LLM 读取 analysis.md（含原始文本节）
     - 追加分析内容（<!-- LLM 分析内容从此处开始 --> 之后）
     - 完成 analysis.md
  5. Update tracking:
     - python track_complete.py <job_dir> "<filename>" "<quality>" "<credibility>" "<note>"
  6. → NEXT (loop back to step 1)
```

### Single-Command Tracking (CRITICAL)

**Do NOT update progress.md step-by-step.** Use `track_complete.py` which does everything in one command:

```bash
python "$SKILL_DIR/scripts/track_complete.py" /path/to/job-dir "张三.pdf" "82" "75" "985硕士,2段实习"
```

This single call: updates worklist ✅ + progress.md (all 5 A-steps) + appends A.log.md.

**If a step fails:** mark ❌ via `worklist_manager.py --fail` and skip the rest.

---

## Progress Reporting to User

**强制执行，不可省略。所有向用户的文字汇报一律使用中文。**

1. **每完成 3 份简历**，立即向用户发送一条进度消息（无论总批量大小）：

   > 📊 进度更新：已处理 3/30 份（10%）。
   > 完成：张三（82分/985硕士）| 李四（65分）| 王五（❌ 提取失败）
   > 下一份：赵六.pdf

2. 进度消息必须以**对话文字**形式发出（不是工具调用输出）。

3. **全部完成后**：发送汇总报告，包含总数、成功/失败统计、下一步建议，全程中文。

4. **连续 3 份失败**：立即告警，不等满 3 份周期。

### 用户询问进度时

HR 问"进度如何"：
- `worklist_manager.py --status` → 简要统计
- `worklist_manager.py --table` → 完整进度表

---

## 图片型 PDF 处理（强制约束）

当 pypdf 提取失败（< 50 字符或乱码），**根据当前模型是否具备多模态能力决定处理方式**：

**模型具备多模态能力时：**
```
直接用 `read` 工具读取原始 PDF 文件 → 模型视觉直接处理
```
- 若识别成功 → 继续 A-S1.5 及后续步骤，记录提取方式"视觉直接处理(PDF)"
- 若识别仍失败 → mark ❌，`worklist_manager.py --fail`，移动下一份

**模型不具备多模态能力时：**
```
直接 mark ❌，原因："PDF文本提取失败，当前模型无多模态能力"
```
- 登记至 A.alerts.md，供 HR 决策

**强制禁止（违反即为执行错误）：**
- ❌ 禁止调用 `pdf_to_png.py` 或任何 PDF → 图片转换逻辑
- ❌ 禁止使用任何本地 OCR 算法（Tesseract/easyocr/paddleocr 等）
- ❌ 禁止 `pip install pymupdf`、`pdf2image`、`Pillow`、`wand` 等
- ❌ 禁止生成任何临时图片文件（.png/.jpg/.ppm/.bmp）作为中间产物

---

## Shell Compatibility (Windows/PowerShell)

- **No `&&` chaining** — PowerShell doesn't support it. Use separate `exec` calls.
- **No inline `python -c` for binary** — shell corrupts byte literals.
- Use **script files** for binary operations.
- Set `env: { "PYTHONIOENCODING": "utf-8" }` for Chinese filenames.
- Use `track_complete.py` (1 call) instead of 5 separate updates.

---

## Context Management for Large Batches

1. **Each resume is a fresh task.** Don't carry previous analysis in memory.
2. **Minimize reference loading:**
   - Read SKILL.md once
   - Read module-A.md only for visual fallback section if needed
   - **Never load full university-ranking.md** (40K+ tokens). Use:
     ```bash
     python "$SKILL_DIR/scripts/query_ranking.py" "$SKILL_DIR/references/university-ranking.md" "学校名"
     ```
   - For well-known 985/211 schools: use LLM knowledge directly
   - For overseas schools: use LLM knowledge for country + approximate QS tier
   - Read file-formats.md only for template reference if unsure
3. **In context:** only current resume text + JD + template.
4. **Worklist is sole coordinator.** Just call `--next`.
5. **Update immediately** after each resume via `track_complete.py`.
6. **Every 10 resumes:** re-read worklist to verify tracking.
7. **Context flush:** after track_complete, drop that resume's data from memory.
8. **Cleanup:** delete .png/.py/.ppm/.bmp temp files after each resume.
