---
name: hr-recruitment
version: 1.0.0
description: >-
  HR resume screening and analysis skill for recruitment workflows. Covers the full pipeline
  from JD analysis to automated screening: (需求解析) deep JD analysis with equivalence reasoning
  and hiring context inference, (简历解析) batch parse resumes into structured profiles with
  field-level confidence, fraud risk detection, and quality scoring, (偏好挖掘) extract hidden
  hiring preferences from hiring manager feedback, (候选人筛选) multi-source criteria screening with
  versioned runs. Use this skill whenever the user mentions resume screening, resume parsing,
  candidate filtering, hiring criteria extraction, JD matching, JD analysis, resume quality
  assessment, 简历筛选, 简历解析, 简历整理, 候选人筛选, 用人条件, 隐藏条件, JD分析,
  岗位需求分析, or any HR recruitment data processing task involving resume files. Also
  activate when the user has a directory of resumes and wants them organized, analyzed,
  ranked, or filtered against a job description.
---

# HR Resume Screening Skill

## Overview

This skill turns a folder of resumes into structured, scored, and ranked candidate reports. It has four modules that share a common workspace and progress system:

| 模块ID | 功能名称 | 做什么 |
|--------|---------|--------|
| D | **需求解析** | JD 逐条解析 → 等效替代推理 → 用人部门上下文理解 → 综合岗位需求 |
| A | **简历解析** | 文本提取 → 水分检测 → 质量评分 → 误分类检测 |
| B | **偏好挖掘** | 解析面试官反馈 → 挖掘未写入 JD 的隐性偏好 → HR 确认 |
| C | **候选人筛选** | 合并条件 → 硬性过滤 → 软性评分 → 排名 + 台账 |

**What this skill does NOT do:**
- Fetch resumes from external platforms (HR provides the files)
- Auto-reject any candidate (all final decisions belong to HR)
- Use OCR libraries or convert PDF to images (uses pypdf for text PDFs; image-type PDFs require model multimodal capability to read directly; if model lacks vision, the resume is skipped)
- Modify source files (resumes/, feedback/, context/ are read-only)

## Prerequisites & Dependencies

This skill runs **within the LobsterAI agent environment** and relies on:

| Dependency | Purpose | Required By |
|-----------|---------|-------------|
| **pdf skill** (official, pre-installed) | 提供 `pypdf` 运行环境，用于 PDF 文本提取 | 简历解析 |
| **docx skill** (official, pre-installed) | 提供 `python-docx` 运行环境，用于 Word 文档提取 | 简历解析 |
| Model vision capability | 图片型 PDF 直接视觉处理（仅 pypdf 失败且模型具备多模态时）；否则放弃该简历 | 简历解析 fallback |

- PDF skill: `~/AppData/Roaming/LobsterAI/SKILLs/pdf/SKILL.md`
- DOCX skill: `~/AppData/Roaming/LobsterAI/SKILLs/docx/SKILL.md`

**Session Skill 检查（简历解析启动前必须执行）：**

在开始处理任何简历之前，检查当前 session 的 skill 列表是否包含 pdf skill 和 docx skill：
- 若 **pdf skill 未启用** → 告知用户在 LobsterAI 的 skill 面板中手动勾选 pdf skill，等待确认后再继续
- 若 **docx skill 未启用** → 同上，要求用户手动勾选 docx skill
- 两者均已启用 → 继续执行

> **Note:** hr-recruitment-skill 自带基础的 pypdf 提取代码（见 `references/module-A.md` A-S1 节），但 pypdf 库本身由官方 pdf skill 提供运行环境。若 skill 未勾选导致 `import pypdf` 失败，应提示用户启用 skill，而非尝试自行安装。

## 默认执行顺序

**全新启动时的标准流程（无需 HR 逐步指定）：**

```
需求解析 → 简历解析 → 偏好挖掘（可选，有面试反馈时）→ 候选人筛选
```

- **需求解析是必要的第一步**：在处理任何简历之前，必须先与 HR 一起理解和确认岗位需求。
- **偏好挖掘是可选的**：仅在 HR 提供了面试反馈数据时运行。
- **简历解析 / 候选人筛选必须按顺序**：候选人筛选依赖简历解析的输出。

## Triggering & Commands

| 用户说 | 行为 |
|--------|------|
| 全新开始 / "我要开始筛选简历" / "帮我筛一批简历" | 初始化工作目录 → 自动启动需求解析 |
| "分析JD" / "解析岗位需求" / "analyze JD" | 单独运行需求解析 |
| "开始解析简历" / "整理简历" / "parse resumes" | 运行简历解析（需求解析已完成时）|
| "分析反馈" / "提取隐藏条件" / "extract hidden criteria" | 运行偏好挖掘 |
| "开始筛选" / "按条件筛一遍" / "screen candidates" | 运行候选人筛选 |
| "继续" / "接着做" / "resume" | 读取 progress.md + log，从中断点继续 |
| "条件改了重跑" / "重新筛选" | 候选人筛选新版本，全量重跑 |
| 意图不明 | 询问 HR 当前想做什么 |

## Workspace Structure

HR designates a **job position directory** as the workspace. The skill creates `skill-output/` inside it. See `references/directory-structure.md` for the complete file tree.

```
{job-dir}/
├── jd.md                    ← JD text (HR provides or skill asks and writes)
├── resumes/                 ← Source resumes (READ-ONLY)
├── feedback/                ← Hiring manager feedback (optional)
├── context/                 ← Hiring context materials (optional, READ-ONLY)
│   └── (面试官简历, 团队介绍, 业务方向说明, etc.)
└── skill-output/
    ├── progress.md          ← Global state file
    ├── D-analysis/          ← Module D: JD analysis & hiring context
    ├── A-parse/             ← Module A: resume copies + structured + analysis
    ├── B-conditions/        ← Module B: hidden criteria
    └── C-screening-v{n}/    ← Module C: versioned screening runs
```

## Core Constraints

1. **Source files are sacred.** Never write to `resumes/`, `feedback/`, or `context/`. All outputs go to `skill-output/`.
2. **Interruptible.** Use `progress.md` + `*.log.md` for checkpoint/resume.
3. **Idempotent.** ✅ + output exists → skip. Non-✅ + output exists → delete output, redo.
4. **Batch reporting.** Don't interrupt processing for issues. Accumulate anomalies, report in batch after phase completes.
5. **All decisions belong to HR.** Never auto-reject. Flag risks, provide scores, let HR decide.
6. **Data stays local.** Resume data is processed locally only.
7. **输出语言：所有向用户的文字汇报、提示、问题、报告，一律使用中文。** 专有名词（公司名、技术术语、文件名、代码）保持原样，其余内容不得出现大段英文。
8. **绝对禁止本地 OCR。** 任何情况下，严禁使用 Tesseract、easyocr、paddleocr、pytesseract 等本地 OCR 算法解析图片，严禁将 PDF 转换为图片再处理。唯一允许的视觉处理路径：当模型具备多模态能力时，直接将原始 PDF 文件发送给模型处理。

## 需求解析（Module D）：JD 深度解析与岗位讨论

需求解析是整个流程的**必要第一步**。它不仅是技术性的 JD 解析，更是一个与 HR 的交互式讨论过程：帮助 HR 真正理解这份 JD，然后共同确认岗位的实际用人标准。Read `references/module-D.md` for complete step definitions.

**为什么需求解析要放在最前面：**
- 技术类 JD 中有大量专业术语，HR 不一定清楚哪些是真正的刚需，哪些是"许愿清单"
- 提前讲清楚用人标准，才能让后续的简历解析和候选人筛选有的放矢
- 需求解析的输出（`comprehensive-requirements.md`）是简历解析/偏好挖掘/候选人筛选的核心输入，越早完成越好

**Prerequisites:** jd.md 存在（或 HR 在对话中提供 JD 文本）。不依赖其他功能。

**Flow:**

1. **D-S0 行业/岗位背景简介** — 基于 LLM 知识，向 HR 简要介绍该类岗位在行业中的定位、典型职责和常见要求体系，帮助 HR 建立认知框架，再进入 JD 解析
2. **D-S1 JD 智能解析** — 逐条分类：🔴刚需 / 🟡等效替代 / 🔵次要 / ⚪加分。识别隐含需求。Output `jd-deep-analysis.md`
3. **D-S2 HR 确认** — 分轮展示分析结果（岗位类型 → 刚需 → 等效替代 → 次要+加分），HR 逐步确认/调整/新增/删除。Output `jd-analysis-confirmed.md`
4. **D-S3 用人部门上下文**（可选）— HR 提供面试官简历、团队构成、业务方向等材料，LLM 做双向假设推理，HR 逐条确认。Output `hiring-context-analysis.md`
5. **D-S4 综合需求生成** — 合并 D-S2 + D-S3，生成最终 `comprehensive-requirements.md`，作为下游功能的增强输入

**Core output:** `comprehensive-requirements.md` — 下游功能的主要需求来源。若需求解析未运行，下游功能退回读取原始 `jd.md`（向后兼容）。

## 简历解析（Module A）：批量简历处理

每份简历经过 5 个步骤处理，产出一个 analysis.md 文件。Read `references/module-A.md` for complete step definitions, scoring rubrics, and templates. Read `references/execution-guide.md` for the operational loop, shell compatibility, and context management rules.

**⚠️ 强制 LLM 精析**：A-S2→A-S5 必须 LLM 逐份推理，禁止批量关键字评分脚本。

**Flow:**

1. **A-S1 文本提取 + 代码写原始文本** — PDF → pypdf；DOCX → python-docx；图片型PDF：若模型具备多模态能力则直接 `read` PDF，否则放弃。提取成功后，Python 代码将原始文本写入 `analysis.md` 第一节（零 token 消耗）。严禁 PDF 转图片或本地 OCR。
2. **A-S2 信息提取** — LLM 读 analysis.md（含原始文本），追加结构化字段 + 置信度。大学归一化（985/211/双一流/QS）。本科/硕士/博士独立评价。
3. **A-S3 水分检测** — 5 维度 → 可信度评分 0-100
4. **A-S4 质量评分** — 5 维度 × 20 = 100 满分，JD 无关
5. **A-S5 误分类检测** — 简历方向 vs JD/综合需求方向匹配

**Per-resume output:** `{filename}.analysis.md`（原始文本节由代码写入 + A-S2～A-S5 分析由 LLM 追加，偏好挖掘/候选人筛选的统一数据源）

**After all resumes:** dedup → `A.alerts.md` → `A.summary.md` → batch report to HR.

**并行模式（> 4 份简历）：** 每批 4 份，最多 3 个子 agent 同时运行，主 agent 审核后汇总。详见 `references/parallel-processing.md`。

## 偏好挖掘（Module B）：隐性条件提取

从面试官的反馈中提取未写入 JD 的真实用人偏好。Read `references/module-B.md` for details.

**Prerequisites:** 简历解析已完成 + `feedback/` 目录有内容。

**Flow:**

1. **B-S1 反馈解析** — 解析各种格式的面试反馈 → 归一化为"候选人 → 结果 → 原因"
2. **B-S2 关联分析** — 将反馈与简历解析数据对照，以 `comprehensive-requirements.md`（或 jd.md）为基线，分析偏差模式
3. **B-S3 条件提取** — 识别偏差规律 → 提炼出带置信度的隐性条件
4. **B-S4 HR 确认** — 每条隐性条件逐一与 HR 确认

**Output:** `feedback-parsed.md` → `extracted-conditions.md` → `confirmed-conditions.md`

## 候选人筛选（Module C）：自动化筛选与排名

按合并后的条件对所有简历进行硬性过滤和软性评分，每次运行创建一个版本目录。Read `references/module-C.md` for details.

**Prerequisites:** 简历解析已完成。偏好挖掘和需求解析可选（有则更好）。

**条件来源（优先级由高到低）：**

| 来源 | 性质 | 产生方式 |
|------|------|---------|
| comprehensive-requirements.md | 结构化 | 需求解析产出（优先使用，没有则退回 jd.md）|
| HR 在对话中直接配置的规则 | 静态 | HR 告知 skill |
| 隐性条件 | 动态 | 偏好挖掘确认产出 |

**Flow:**

1. **C-S1 条件合并** — 合并所有来源 → 分类为硬性/软性
2. **C-S2 标准确认** — HR 审核合并后的筛选标准
3. **C-S3 硬性过滤** — 通过 / 淘汰 / 信息不足
4. **C-S4 软性评分** — 多维度加权评分
5. **C-S5 排名与输出** — `screening-result.md` + `ledger.md`

**重跑：** 条件变更 → 新建 `C-screening-v{n+1}/`，全量重跑。简历解析无需重跑。

## Module Dependencies

```
【标准执行顺序】
需求解析（D）→ 简历解析（A）→ 偏好挖掘（B，可选）→ 候选人筛选（C）

jd.md ──→ 需求解析（D-S0/S1 输入）

D-analysis/comprehensive-requirements.md
  ├──→ 简历解析（A-S5 误分类检测，增强版）
  ├──→ 偏好挖掘（B-S2 基线对比）
  └──→ 候选人筛选（C-S1 主要条件来源）

A-parse/*.analysis.md
  ├──→ 偏好挖掘（关联分析数据源）
  └──→ 候选人筛选（每份简历的筛选依据）

B-conditions/confirmed-conditions.md ──→ 候选人筛选（隐性条件）
```

**Fallback:** 若 comprehensive-requirements.md 不存在，下游功能直接读取 jd.md（向后兼容）。

## Human Interaction Points

| 功能 | 时机 | 内容 | 阻塞? |
|------|------|------|-------|
| 初始化 | JD 缺失 | 请 HR 在对话中输入 JD 文本，skill 写入 jd.md | 是 |
| 需求解析 | D-S0 | 向 HR 展示行业/岗位背景简介，确认理解无误后继续 | 是 |
| 需求解析 | D-S2 | 分轮确认 JD 解析结果（岗位类型 → 刚需 → 等效替代 → 次要+加分） | 是 |
| 需求解析 | D-S3 | 确认上下文材料推理结论（每条推理 HR 表态：采纳/否认/调整）| 是 |
| 简历解析 | 全部简历处理完毕后 | 批量汇报 alerts | 是 |
| 偏好挖掘 | B-S4 | 逐条确认提取出的隐性条件 | 是 |
| 候选人筛选 | C-S2 | 确认合并后的筛选标准 | 是 |
| 候选人筛选 | 完成后 | HR 审阅结果，决定是否调整条件重跑 | 否 |

## Initialization & Recovery

Every time the skill starts, run this sequence. See `references/progress-system.md` for the state machine.

```
Skill Start
├── 扫描工作目录
│   ├── 查找 jd.md
│   │   ├── 存在 → 读取
│   │   └── 不存在 → 扫描工作目录是否有其他可能是 JD 的文件（如 job.md / 职位描述.txt 等）
│   │       ├── 找到疑似 JD 文件 → 向 HR 确认是否即为 JD，确认后复制内容写入 jd.md
│   │       └── 未找到 → 告知 HR，请其直接在对话中粘贴 JD 文本，skill 写入 jd.md
│   └── 扫描 resumes/ 目录 → 统计文件数量和类型，向 HR 汇报
│
└── 检查 skill-output/
    ├── 不存在 → FRESH START
    │   ├── 运行 init_workspace.py → 创建目录结构，复制简历到 A-parse/，初始化 progress.md
    │   ├── 向 HR 汇报：工作目录已初始化，发现简历 {N} 份（PDF {n}，DOCX {n}，图片 {n}）
    │   └── 自动启动需求解析：开始与 HR 一起解析和讨论 JD
    │       （完成后依次进行简历解析 → 视情况偏好挖掘 → 候选人筛选）
    └── 存在 → RECOVERY
        ├── 读取 progress.md → 获取每份简历每个步骤的状态
        ├── 读取相关 log.md → 了解上次中断时的上下文
        ├── 一致性检查（见 progress-system.md）
        ├── 检测新增文件 → 追加为 ⏳
        └── 从第一个 ⏳ 步骤继续
```

## Scripts

Helper scripts for mechanical I/O operations. The model focuses on semantic analysis.

| Script | Purpose |
|--------|---------|
| `init_workspace.py` | Create directory structure, copy resumes, init progress |
| `track_complete.py` | **Primary tracker** — updates worklist + progress + log in ONE call |
| `worklist_manager.py` | Worklist CRUD, get next file, record failures |
| `progress_manager.py` | Low-level progress.md ops (rarely needed directly) |
| `log_utils.py` | Append timestamped log entries |
| `file_utils.py` | File type detection, safe copy |
| `pdf_to_png.py` | ~~Image-PDF → PNG~~ **已废弃，禁止调用** |
| `query_ranking.py` | On-demand university ranking lookup (avoids loading 40K+ file) |
| `parallel_split.py` | Split worklist into N groups for parallel mode |

**Key usage:**
```bash
python "$SKILL_DIR/scripts/init_workspace.py" /path/to/job-dir
python "$SKILL_DIR/scripts/worklist_manager.py" /path/to/job-dir --next
python "$SKILL_DIR/scripts/track_complete.py" /path/to/job-dir "张三.pdf" "82" "75" "985硕士"
python "$SKILL_DIR/scripts/worklist_manager.py" /path/to/job-dir --fail "王五.png" "提取失败"
python "$SKILL_DIR/scripts/pdf_to_png.py" /path/to/resume.pdf /path/to/output.png
python "$SKILL_DIR/scripts/query_ranking.py" "$SKILL_DIR/references/university-ranking.md" "学校名"
```

## Reference Files

| File | When to Read | Content |
|------|-------------|---------|
| `references/module-D.md` | 启动需求解析时 | D-S0→D-S4 完整定义：行业简介、JD解析、HR确认、上下文推理、综合需求生成 |
| `references/module-A.md` | 启动简历解析时 | A-S1→A-S5 步骤定义、字段模式、评分规则、输出模板 |
| `references/module-B.md` | 启动偏好挖掘时 | B-S1→B-S4 详细说明、反馈解析、条件格式 |
| `references/module-C.md` | 启动候选人筛选时 | C-S1→C-S5 详细说明、条件合并方法、筛选逻辑 |
| `references/execution-guide.md` | 运行简历解析时 | 执行循环、Shell兼容性、上下文管理、进度汇报 |
| `references/parallel-processing.md` | 大批量（30+份）时 | 并行架构、子session协议、失败回退 |
| `references/directory-structure.md` | 初始化时 | 完整文件树、命名规范、目录归属 |
| `references/progress-system.md` | 恢复/调试时 | 状态机、状态图标、恢复规则、幂等性 |
| `references/file-formats.md` | 写输出文件时 | 所有输出模板：analysis.md、需求解析输出、筛选结果等 |
| `references/university-ranking.md` | A-S2 院校归一化时 | 985/211/双一流名单、QS排名、简称对照（通过脚本查询）|
