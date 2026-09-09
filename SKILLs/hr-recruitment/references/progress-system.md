# Progress System — Complete Reference

This document defines the state machine, status icons, recovery logic, and idempotency rules that drive the entire skill's reliability.

## Two Core Files

The progress system uses two complementary files:

| File | Question It Answers | Write Mode | Count |
|------|-------------------|-----------|-------|
| `progress.md` | "Where are we now?" | Overwrite-update (replace old state) | 1 globally |
| `*.log.md` | "What happened and why?" | Append-only (never modify existing entries) | 1 per module |

### Why Two Files?

- **progress.md** is the **primary recovery driver**. Read it to know which file is at which step. It's compact and parseable.
- **log.md** is the **context provider**. When resuming from an interruption, it tells you what was happening when things stopped — which helps decide whether to clean up partial work or just continue.

## Status Icons

| Icon | Name | Meaning |
|------|------|---------|
| ✅ | Complete | Step finished successfully, output verified |
| 🔄 | In Progress | Step was started but not confirmed complete (potential interruption) |
| ⏳ | Pending | Step has not been started yet |
| ⏭️ | Skipped | Step intentionally skipped (duplicate resume, HR decision, etc.) |
| ❌ | Failed | Step failed with an error (reason attached) |

## progress.md Format

```markdown
# 全局进度

## 岗位信息
- 岗位目录：{absolute path}
- JD来源：jd.md
- 简历总数：{count}
- 当前功能C版本：v{n}
- 最后更新：{timestamp}

## 状态图例
- ✅ 完成
- 🔄 进行中
- ⏳ 待处理
- ⏭️ 跳过
- ❌ 失败

---

### #{sequence} {filename}
- 源文件：resumes/{filename}
- 副本：skill-output/A-parse/{filename}
- 去重状态：唯一 | ⏭️ 与#{other}确认重复 | 疑似重复待确认
- A-S1 文本提取：{status} {method if complete}
- A-S2 信息抽取：{status}
- A-S3 注水检测：{status} {credibility score if complete}
- A-S4 质量评分：{status} {overall score if complete}
- A-S5 误分类检测：{status} {note if flagged}
- A 输出：A-parse/{filename}.analysis.md
- C-v{n}-S3 硬性过滤：{status} {result if complete}
- C-v{n}-S4 软性评分：{status} {score if complete}
- C-v{n}-S5 综合排序：{status} {rank if complete}
- 备注：{any notes}
```

### Update Rules for progress.md

- **Overwrite** the entire file each time you update (do not append)
- Update immediately after each step completes for each resume
- Include the timestamp in the header
- Keep the sequential numbering (#1, #2, ...) stable — don't renumber

**关于 A-S1 完成判定：**

A-S1 包含两个子操作：① Python 提取文字，② Python 代码将原始文本写入 `{filename}.analysis.md` 的第一节。两步均完成后，才将 A-S1 标记为 ✅。`track_complete.py` 在标记所有步骤 ✅ 时，假设 analysis.md 已存在且原始文本节已写入。

**analysis.md 一致性检查规则（恢复时适用）：**

| progress.md A-S1 状态 | analysis.md 存在? | 处理方式 |
|----------------------|------------------|---------|
| ✅ | Yes | ✅ 正常，跳过 |
| ✅ | No | ⚠️ 不一致 — 将 A-S1 标记为 ⏳，重做 |
| 🔄 | Yes or No | ⚠️ 中断 — 将 A-S1 标记为 ⏳，删除 analysis.md（如存在），重做 |
| ⏳ | Yes | ⚠️ 孤立文件 — 删除 analysis.md，保持 ⏳ |
| ⏳ | No | ✅ 正常 — 处理此文件 |

## Recovery Logic

When the skill starts and finds an existing `skill-output/`:

### Step 1: Read progress.md

Parse the file to get each resume's per-step status. Build a mental map of the overall state.

### Step 2: Read the current module's log.md

Read the last few entries of the relevant log file to understand:
- Which file was being processed last?
- Which step was it on?
- Was there an error or was it mid-processing?

### Step 3: Consistency Check

For each resume, for each step:

| progress.md State | Output File Exists? | Action |
|-------------------|-------------------|--------|
| ✅ | Yes | ✅ Skip — already done |
| ✅ | No | ⚠️ Inconsistent — mark as ⏳ and redo |
| 🔄 | Yes | ⚠️ Interrupted — delete output, mark as ⏳, redo |
| 🔄 | No | ⚠️ Interrupted before output — mark as ⏳, redo |
| ⏳ | Yes | ⚠️ Orphan output — delete output, keep ⏳ |
| ⏳ | No | ✅ Normal — process this step |
| ❌ | Any | Skip (already recorded as failed) |
| ⏭️ | Any | Skip (intentionally skipped) |

### Step 4: Detect New Files

Compare `resumes/` contents against the files listed in progress.md:
- Files in resumes/ but not in progress.md → new additions
- For each new file: copy to A-parse/, append a new entry to progress.md with all steps as ⏳

### Step 5: Resume Processing

Find the first resume with a 🔄 or ⏳ step and continue from there.

## Idempotency Rules

| Scenario | Behavior |
|----------|----------|
| Recovery with no condition changes | Read progress + log, continue from breakpoint. ✅ steps never re-run. |
| Module A done, Module C interrupted | A does not re-run. Resume C from breakpoint. |
| Module C criteria change | New version directory, full re-run of C. A does not re-run. |
| New resumes added to resumes/ | Detect new files → copy to A-parse → append to progress as ⏳ |
| Re-executing completed step | ✅ + output exists → skip |
| Output exists but not ✅ | Delete output, redo step (interrupted residue) |
| HR edits screening-criteria.md | Treat as criteria change → new version re-run of C |

## Log File Format

Each log entry follows this pattern:

```markdown
## [{timestamp}] {description}
- {detail line 1}
- {detail line 2}
- ...
```

Example:
```markdown
## [2026-05-12 15:31] #1 张三.pdf
- A-S1 文本提取：pdf skill，成功，3页，约 1200 字
- A-S2 信息抽取：提取到 姓名/手机/学历/2段实习/1个项目/6项技能
  - 低置信度字段 2 个：学历（未注明全日制）、Docker（无佐证）
- A-S3 注水检测：可信度 72/100
  - 风险点 2 个：学历疑点(中)、经历深度(低)
- A-S4 质量评分：75/100（教育14 经历16 技能13 稳定性18 写作14）
- A-S5 误分类检测：无异常
- 输出：A-parse/张三.pdf.analysis.md
```

### Log Best Practices

- Always include the timestamp
- Always include the resume number and filename
- For each step, record: method used, success/failure, key metrics
- For failures, record the specific error
- Keep entries concise but complete enough to understand what happened without reading the output files
