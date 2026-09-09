# Module C: Automated Screening — Complete Reference

This document contains everything needed to execute Module C. Read it when starting Module C.

## Table of Contents

1. [Positioning](#positioning)
2. [Prerequisites](#prerequisites)
3. [Versioning System](#versioning-system)
4. [C-S1: Criteria Merge](#c-s1-criteria-merge)
5. [C-S2: Standard Confirmation](#c-s2-standard-confirmation)
6. [C-S3: Hard Filter](#c-s3-hard-filter)
7. [C-S4: Soft Scoring](#c-s4-soft-scoring)
8. [C-S5: Ranking & Output](#c-s5-ranking--output)
9. [Re-run Mechanism](#re-run-mechanism)
10. [Output Templates](#output-templates)

---

## Positioning

Module C is the culmination of the pipeline. It takes the structured resume data from Module A, applies multi-source screening criteria, and produces a ranked candidate list with full transparency on why each candidate passed or was rejected.

Every screening run is versioned — criteria and results are archived together so HR can compare different filtering strategies side by side.

## Prerequisites

Before starting Module C, verify:

1. **Module A is complete.** C reads `A-parse/*.analysis.md` as its data source. If Module A isn't done, offer to run it first.
2. **jd.md exists.** This is the primary criteria source. If missing, ask HR.
3. **Check for HR-configured criteria.** Ask HR if they have specific hard rules (红线) or preferences beyond the JD. If they do, collect them before proceeding.
4. **Check for confirmed hidden criteria.** Look for `B-conditions/confirmed-conditions.md`. If it doesn't exist, that's fine — C can run with just JD + HR config. Inform HR that hidden criteria from feedback analysis are not available and ask if they want to run Module B first or proceed without.

## Versioning System

Every Module C run creates a new version directory:

- First run: `C-screening-v1/`
- After criteria change: `C-screening-v2/`
- And so on...

To determine the next version number: scan existing `C-screening-v*/` directories, find the highest N, create `C-screening-v{N+1}/`.

Each version directory is self-contained:
```
C-screening-v{n}/
├── C.log.md                ← This version's process log
├── screening-criteria.md   ← This version's complete criteria (archived, editable)
├── screening-result.md     ← Screening results (ranking, pass/reject, reasons)
└── ledger.md               ← Ledger format (copy-pasteable to spreadsheets)
```

Old versions are **never deleted or modified**. They serve as comparison baselines.

---

## C-S1: Criteria Merge

### 第一步：确定 JD 条件主来源

**在读取任何条件之前，先检查 `D-analysis/comprehensive-requirements.md` 是否存在：**

- **存在** → 使用它替代 `jd.md`。直接读取已分类的刚需/等效替代/次要/加分项，无需自行解析原始 JD。在 screening-criteria.md 中注明来源为 `comprehensive-requirements.md`。
- **不存在** → 从原始 `jd.md` 自行解析（执行 JD 要求提取和四级分类，参考 Module D 的分类逻辑）。在 screening-criteria.md 中注明来源为 `jd.md`。

### Three Sources

| Source | File | Nature | What to Extract |
|--------|------|--------|----------------|
| **JD/综合需求** | `D-analysis/comprehensive-requirements.md`（优先）或 `jd.md`（回退） | Semi-static | 刚需→硬性条件；等效替代→组内OR硬性条件；次要/加分→软性条件 |
| **HR配置条件** | Collected via conversation | Static | Hard rules (红线: "不接受三本"), preferences ("优先985"), any other criteria HR states |
| **隐藏条件** | `B-conditions/confirmed-conditions.md` | Dynamic | Accepted conditions with their types and weights |

### Merging Logic

1. **Parse JD/综合需求:** 如果使用 comprehensive-requirements.md，刚需直接映射为硬性条件，等效替代映射为"组内OR"的硬性条件，次要/加分映射为软性条件，无需二次解析。如果使用原始 jd.md，则提取可评估的具体条件：
   - "本科以上学历" → 硬性: degree ≥ 本科
   - "熟悉 Java 或 Python" → 硬性（等效替代）: skills include Java OR Python
   - "有后端开发经验者优先" → 软性: backend experience, positive weight

2. **Integrate HR rules:** HR-stated conditions override JD interpretations if they conflict. HR conditions can be:
   - **红线 (Hard rules):** Fail = reject. "不接受三本院校", "毕业时间必须在2026年"
   - **偏好 (Preferences):** Weighted in soft scoring. "优先985/211"

3. **Integrate hidden criteria:** Each confirmed condition from Module B comes with a type (hard/soft) and weight. Add them to the merged set.

4. **Classify each condition** as either:
   - **硬性 (Hard):** Not meeting this condition → candidate is rejected (unless information is insufficient, in which case → "信息不足待判")
   - **软性 (Soft):** Contribute to weighted scoring. Each has a weight level.

### Conflict Resolution

If sources disagree:
- HR explicit rules always take precedence
- Hidden criteria (from feedback) supplement but don't override HR rules
- JD provides the baseline; anything not contradicted by HR/hidden conditions stays

---

## C-S2: Standard Confirmation

### Present to HR

Before screening begins, show the merged criteria to HR in full. Format the presentation clearly:

```
硬性条件（不满足则淘汰）：
1. 学历：本科及以上 [来源：JD]
2. 技能：熟悉 Java 或 Python [来源：JD]
3. 不接受三本院校 [来源：HR配置]
4. 毕业时间必须在2026年 [来源：HR配置]

软性条件（加权评分）：
1. 有后端开发实习经历 [来源：JD] [权重：中]
2. 熟悉 Spring Boot [来源：JD] [权重：低]
3. 优先985/211 [来源：HR配置] [权重：中]
4. 偏好有大厂实习经历 [来源：功能B，HR已确认] [权重：中]
5. 项目有量化成果描述 [来源：功能B，HR已确认] [权重：低]
```

Ask HR to confirm, or modify. **This is a blocking step** — do not proceed to screening until HR approves.

### Archive to screening-criteria.md

After HR confirms, write the finalized criteria to `C-screening-v{n}/screening-criteria.md`. See `references/file-formats.md` for the exact template. This file serves dual purposes:
- **Archive:** Record of exactly what criteria were used for this version
- **Editable:** HR can later edit this file and tell the skill to re-run, creating a new version

---

## C-S3: Hard Filter

### Process

For each resume (reading from `A-parse/*.analysis.md`):

1. Check every hard condition against the resume's structured data
2. Classify the result:

| Result | Meaning | Condition |
|--------|---------|-----------|
| **✅ 通过** | All hard conditions met | Every hard criterion satisfied |
| **❌ 淘汰** | At least one hard condition failed | Clear data shows criterion not met |
| **⚠️ 信息不足** | Cannot determine one or more hard conditions | Field confidence is "低" or data is missing for a required criterion |

3. For rejected candidates: record which specific hard condition caused rejection
4. For insufficient-info candidates: record which fields are missing and which conditions can't be evaluated

### Using Confidence Levels

The confidence annotations from Module A are critical here:

- **High confidence** field not meeting a criterion → reject with confidence
- **Medium confidence** field not meeting a criterion → reject but note the uncertainty
- **Low confidence** or missing field that's needed for a hard criterion → mark as "信息不足", recommend HR verify

### C-S3 Completion

- Update progress.md for each file's C-v{n}-S3 status
- Append to C.log.md: pass/reject/insufficient counts

---

## C-S4: Soft Scoring

### Who Gets Scored

Only candidates who **passed** the hard filter (✅ in C-S3). Rejected and insufficient-info candidates are not scored.

### Scoring Methodology

For each soft condition, evaluate the candidate and assign a score:

| Score Range | Meaning |
|-------------|---------|
| 0-20 | Does not meet this criterion at all |
| 21-40 | Minimally meets |
| 41-60 | Partially meets |
| 61-80 | Mostly meets |
| 81-100 | Fully meets or exceeds |

### Weighted Aggregation

Each soft condition has a weight. The final soft score is the weighted average:

```
Soft Score = Σ (condition_score × condition_weight) / Σ (condition_weight)
```

Weight levels map to multipliers:
- 高 (High) = 3
- 中 (Medium) = 2
- 低 (Low) = 1

### Dimension Grouping (for result display)

Group soft scores into meaningful categories for the output table:

| Category | Includes |
|----------|----------|
| **JD匹配** | Scores from JD-sourced soft conditions |
| **HR偏好** | Scores from HR-configured preferences |
| **隐藏条件** | Scores from Module B confirmed conditions |

### C-S4 Completion

- Update progress.md for each file's C-v{n}-S4 status
- Append to C.log.md: scoring details for each candidate

---

## C-S5: Ranking & Output

### Comprehensive Score

The final ranking combines:
- **Soft Score** (from C-S4): The weighted screening score
- **A Quality Score** (from Module A): The resume quality baseline
- **Credibility Score** (from Module A): Risk assessment

**排名规则（明确）：**
- **主排序**：综合筛选分（Soft Score）降序
- **次排序**：同分时以 A 质量分为次序（降序）
- **注水可信度 < 50** 的候选人在排名表中用 ⚠️ 标记，位次保持不变（HR 自行决策）
- 三列分数在输出中独立展示，不合并为单一综合分——HR 需要透明看到每个维度

Display all three scores in the output, ranked primarily by Soft Score (the screening-specific metric). Include the other scores for HR context.

### Generate Three Output Files

1. **screening-result.md** — Full detailed results with funnel, ranking table, rejection list, and insufficient-info list
2. **ledger.md** — Simplified tabular format that can be copy-pasted directly into spreadsheet tools (Feishu/Shimo/Excel)
3. **C.log.md** — Append final summary entry

See `references/file-formats.md` for exact templates of all three.

### C-S5 Completion

- Update progress.md for all files' C-v{n}-S5 status
- Write screening-result.md
- Write ledger.md
- Append completion summary to C.log.md
- Report to HR: "筛选完成。{通过数}人通过，{淘汰数}人淘汰，{待判数}人信息不足。详见 screening-result.md。"

---

## Re-run Mechanism

| Scenario | What Happens |
|----------|-------------|
| Module B produces new confirmed conditions | Create C-screening-v{n+1}/, full re-run C with updated criteria |
| HR manually edits screening-criteria.md | HR tells skill → create new version, full re-run |
| HR adds/modifies hard rules in conversation | Create new version, full re-run |
| Module A results unchanged | C re-run reads same A-parse/*.analysis.md, does NOT re-run A |
| Old versions | Preserved for comparison. HR can diff criteria and results across versions |

### How to Handle Re-run

1. Determine the new version number
2. Create the new version directory
3. In C-S1, start fresh: re-read all three sources (some may have changed)
4. If only one source changed, note in screening-criteria.md what changed (变更说明)
5. Run C-S2 through C-S5 as usual
6. In the criteria file, include a "v{n-1} → v{n} 变更记录" section listing what changed
