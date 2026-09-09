# Directory Structure — Complete Reference

This document defines every directory and file in the workspace. Read it during initialization or when unsure about file paths and naming.

## Complete File Tree

```
{岗位根目录}/                                  ← HR designates this as the job position workspace
│
├── jd.md                                      ← JD text (HR provides, or skill asks and writes)
│
├── resumes/                                   ← Source resumes (READ-ONLY — skill never modifies)
│   ├── 张三.pdf
│   ├── 李四.docx
│   ├── 王五.png
│   └── ...
│
├── feedback/                                  ← Hiring manager feedback (optional, heterogeneous)
│   └── (any format: spreadsheets, text, directories, mixed)
│
├── context/                                   ← Hiring context materials (optional, READ-ONLY)
│   ├── {面试官简历.pdf}                       ← E.g., interviewer/manager resume
│   ├── {团队介绍.md}                          ← E.g., team composition info
│   ├── {业务方向说明.docx}                    ← E.g., business direction notes
│   └── ...                                    ← Any format, HR provides
│
└── skill-output/                              ← ALL skill outputs — isolated from source files
    │
    ├── progress.md                            ← Global state file (overwrite-update)
    │
    ├── D-analysis/                            ← Module D: JD analysis & hiring context
    │   ├── D.log.md                           ← Module D process log (append-only)
    │   ├── jd-deep-analysis.md                ← D-S1: LLM raw JD analysis (before HR confirmation)
    │   ├── jd-analysis-confirmed.md           ← D-S2: HR-confirmed JD analysis
    │   ├── hiring-context-analysis.md         ← D-S3: Context material analysis (optional)
    │   └── comprehensive-requirements.md      ← D-S4: Final merged requirements (下游模块读取)
    │
    ├── A-parse/                               ← Module A: resume copies + analysis results (paired)
    │   ├── A.log.md                           ← Module A process log (append-only)
    │   ├── A.worklist.md                      ← Processing progress table (overwrite-update)
    │   ├── A.summary.md                       ← Module A summary report (generated after all done)
    │   ├── A.alerts.md                        ← Items needing HR attention (misclass/dupes/failures)
    │   │
    │   ├── 张三.pdf                           ← Resume copy (from resumes/)
    │   ├── 张三.pdf.analysis.md               ← 原始文本（代码写入）+ 完整分析结果（LLM写入）
    │   ├── 李四.docx
    │   ├── 李四.docx.analysis.md
    │   └── ...
    │
    ├── B-conditions/                          ← Module B: hidden criteria extraction
    │   ├── B.log.md                           ← Module B process log (append-only)
    │   ├── feedback-parsed.md                 ← Standardized feedback parsing result
    │   ├── extracted-conditions.md            ← Extracted conditions (unconfirmed)
    │   └── confirmed-conditions.md            ← HR-confirmed final conditions
    │
    ├── C-screening-v1/                        ← Module C version 1
    │   ├── C.log.md                           ← This version's process log (append-only)
    │   ├── screening-criteria.md              ← This version's complete criteria (archived, editable)
    │   ├── screening-result.md                ← Screening results (ranking, pass/reject, reasons)
    │   └── ledger.md                          ← Ledger format output (copy-pasteable to spreadsheets)
    │
    ├── C-screening-v2/                        ← Version 2 after criteria change (same structure)
    │   └── ...
    │
    └── C-screening-v.../                      ← Versions accumulate, never deleted
```

## Naming Conventions

### Resume Copy & Analysis Pairing

Each resume in `A-parse/` produces TWO files (copy + analysis):
- Copy: `A-parse/{original_filename}` — exact same filename as in resumes/
- Analysis: `A-parse/{original_filename}.analysis.md` — 原始文本（代码写入）+ 完整分析结果（LLM写入）

Examples:
- `resumes/张三.pdf` → `A-parse/张三.pdf` + `A-parse/张三.pdf.analysis.md`
- `resumes/李四.docx` → `A-parse/李四.docx` + `A-parse/李四.docx.analysis.md`

### Version Directories

Module C versions follow the pattern `C-screening-v{N}/` where N starts from 1.

## File Purposes Summary

| File | Owner | Write Mode | Purpose |
|------|-------|-----------|---------|
| `jd.md` | HR / Skill init | Write once | JD text, input to Module D |
| `progress.md` | Skill | Overwrite-update | Global state for recovery |
| `D.log.md` | Skill | Append-only | Module D process details |
| `jd-deep-analysis.md` | Skill | Write once | D-S1 raw JD analysis, pre-confirmation |
| `jd-analysis-confirmed.md` | Skill | Write once | D-S2 HR-confirmed JD analysis |
| `hiring-context-analysis.md` | Skill | Write once | D-S3 context analysis (optional) |
| `comprehensive-requirements.md` | Skill | Write once (re-run overwrites) | Final merged requirements, primary downstream source |
| `A.log.md` | Skill | Append-only | Module A process details |
| `A.worklist.md` | Skill | Overwrite-update | Processing progress table |
| `A.summary.md` | Skill | Write once | Module A summary with stats |
| `A.alerts.md` | Skill | Write once | Anomalies needing HR attention |
| `*.analysis.md` | Skill | Two-phase write (code then LLM) | 原始文本 + 完整分析结果，Module B/C 的数据源 |
| `B.log.md` | Skill | Append-only | Module B process details |
| `feedback-parsed.md` | Skill | Write once | Standardized feedback data |
| `extracted-conditions.md` | Skill | Write once | Unconfirmed hidden criteria |
| `confirmed-conditions.md` | Skill | Write once | HR-confirmed criteria |
| `C.log.md` | Skill | Append-only | Module C version process details |
| `screening-criteria.md` | Skill / HR | Write once, HR may edit | Archived criteria for this version |
| `screening-result.md` | Skill | Write once | Screening results and ranking |
| `ledger.md` | Skill | Write once | Copy-pasteable tabular output |

## Directory Ownership

| Directory | Written By | Read By |
|-----------|-----------|---------|
| `resumes/` | HR only | Skill (read-only) |
| `feedback/` | HR only | Skill (read-only) |
| `context/` | HR only | Skill (read-only) |
| `skill-output/` | Skill only | Skill + HR |
| `D-analysis/` | Skill | Skill (A, B, C) + HR |
| `A-parse/` | Skill | Skill (B, C) + HR |
| `B-conditions/` | Skill | Skill (C) + HR |
| `C-screening-v{n}/` | Skill + HR (criteria edit) | Skill + HR |
