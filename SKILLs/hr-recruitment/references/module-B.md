# Module B: Hidden Criteria Extraction — Complete Reference

This document contains everything needed to execute Module B. Read it when starting Module B.

## Table of Contents

1. [Positioning](#positioning)
2. [Prerequisites](#prerequisites)
3. [B-S1: Feedback Data Parsing](#b-s1-feedback-data-parsing)
4. [B-S2: Correlation Analysis](#b-s2-correlation-analysis)
5. [B-S3: Condition Extraction](#b-s3-condition-extraction)
6. [B-S4: HR Confirmation](#b-s4-hr-confirmation)
7. [Output Templates](#output-templates)

---

## Positioning

Hiring managers' real preferences are often not written in the JD. They emerge through patterns in who they accept and reject. Module B finds these patterns by analyzing actual feedback data, correlating it with the structured resume profiles from Module A, and presenting the findings to HR for confirmation.

The confirmed conditions flow into Module C as an additional screening source.

## Prerequisites

Before starting Module B, verify both:

1. **feedback/ directory exists and has content.** If missing or empty, ask HR: "用人部门的反馈数据放在哪了？需要将反馈文件放入 feedback/ 目录。" Do not proceed until data is available.

2. **Module A is complete.** Module B needs the structured resume data from `A-parse/*.analysis.md` to correlate with feedback. If Module A is not finished, tell HR: "需要先完成功能A（简历解析）才能进行反馈分析。" and offer to run Module A first.

---

## B-S1: Feedback Data Parsing

### The Challenge

Feedback data comes in unpredictable formats. The `feedback/` directory might contain:

- **Spreadsheet files** (Excel/CSV) — rows with candidate names, results, and comments
- **Text files** — free-form notes, meeting minutes, email chains
- **Directory structure** — folders like "通过/" and "不通过/" with resume copies or notes inside
- **Mixed formats** — any combination of the above
- **Chat exports** — WeChat/DingTalk conversation logs discussing candidates

### Parsing Strategy

1. **Scan the entire feedback/ directory** — list all files and subdirectories, understand the overall structure before parsing anything.

2. **For each file, determine format and extract what you can:**
   - Excel/CSV: Read as tabular data. Look for columns that represent candidate name, result (pass/fail/pending), and comments/reasons.
   - Text files: Read and identify candidate-related mentions. Look for patterns like "张三 — 不错，技术扎实" or "李四淘汰，经验太浅".
   - Directory structure: Folder names often encode results. Files within may provide details.
   - If a file format is unrecognizable, record it in B.log.md and skip (don't fail the whole process).

3. **Normalize everything** into a standard structure: `候选人 → 结果 → 原因/评价 → 数据来源`

4. **Handle ambiguity gracefully:**
   - If a candidate name in feedback doesn't match any resume in A-parse/, note the mismatch but still record the data point.
   - If a result is ambiguous (e.g., "再考虑" — could be positive or negative), record as "待定" with the original text.
   - If you truly cannot parse something, ask HR for clarification on that specific item.

### Output: feedback-parsed.md

Write the standardized result to `B-conditions/feedback-parsed.md`. Format:

```markdown
# 反馈数据解析结果

## 数据来源概览
- 扫描文件数：X
- 成功解析：Y
- 无法解析：Z（已记录到 B.log.md）

## 标准化反馈

| 候选人 | 结果 | 原因/评价 | 数据来源 |
|--------|------|-----------|---------|
| 张三 | 通过 | 项目经验扎实，沟通能力好 | feedback/面试记录.xlsx 第3行 |
| 李四 | 不通过 | 技术深度不够 | feedback/面试记录.xlsx 第4行 |
| 王五 | 通过 | — (无评价) | feedback/通过名单.txt |
| 赵六 | 不通过 | 经历太短，不稳定 | feedback/淘汰/ 目录下有此文件 |

## 未匹配项
| 反馈中的名称 | 原因 | 建议 |
|-------------|------|------|
| "小王" | 无法确定对应哪份简历 | 请HR确认是否指王五 |
```

### B-S1 Completion

- Write feedback-parsed.md
- Append to B.log.md: file scan results, parse successes/failures, name matching stats

---

## B-S2: Correlation Analysis

### What to Correlate

Map each feedback entry to the corresponding resume's structured data. For each matched candidate, read **both**:
- `A-parse/{filename}.structured.md` — 原始字段值（公司名、学校、时间线、职位等原文，作为比对的事实依据）
- `A-parse/{filename}.analysis.md` — 处理后的评分（质量分/可信度/院校层次归一化结果）

Build a comparative picture:

- **Accepted candidates:** What do they have in common? (Schools, companies, skill patterns, experience depth, quality scores)
- **Rejected candidates:** What do they lack or have differently?
- **JD stated requirements vs actual acceptance pattern:** Where do they diverge?

### Analysis Approach

1. **Load the data:** Read each matched candidate's `.analysis.md` file. Note their education tier, experience count/quality, skill profile, quality score, and risk score.

2. **Group by result:** Separate into accepted/rejected/pending groups.

3. **Find statistical patterns:**
   - Average quality score of accepted vs rejected
   - Education distribution in accepted vs rejected
   - Common skills in accepted group that rejected group lacks
   - Experience characteristics (company prestige, duration, role level)

4. **Identify divergences from JD:**
   - JD says "本科以上" but all accepted candidates are 985/211
   - JD doesn't mention specific companies but all accepted had big-company internships
   - JD lists Python but accepted candidates all used Java

5. **Note the sample size** — with 10-30 resumes, patterns based on fewer than 3 data points should be flagged as low-confidence.

### B-S2 Completion

- Append correlation findings to B.log.md
- This step doesn't produce a standalone file — findings flow into B-S3

---

## B-S3: Condition Extraction

### From Patterns to Conditions

Convert the correlation analysis into a concrete list of hidden conditions. Each condition must include:

| Field | Description |
|-------|-------------|
| **描述** (Description) | Clear, actionable statement of the preference |
| **置信度** (Confidence) | 高/中/低, based on how many data points support it |
| **合理性判断** (Reasonableness) | Is this preference professionally justifiable? Flag potential biases. |
| **支撑案例** (Supporting Cases) | Specific candidates whose accept/reject supports this pattern |

### Reasonableness Assessment

This is where the skill adds unique value. Not all hidden preferences are appropriate:

**首先过滤：性别和年龄相关的倾向模式一律跳过，不提取、不标记、不向 HR 呈现。** 除非 HR 已在对话中明确说明有此类要求，否则这类模式视为不存在。

**其他模式的合理性判断参考框架：**

| 模式类型 | 合理性 | 处理方式 |
|---------|--------|---------|
| 偏好有大厂实习经历 | ✅ 合理 | 提取，标注"行业经验信号" |
| 偏好985/211院校 | ✅ 合理（加分偏好） | 提取，若仅2个数据点标低置信度 |
| 不接受频繁跳槽 | ✅ 合理 | 提取，建议HR明确时间定义 |
| 偏好特定院校（如只要清北）| ⚠️ 过强 | 提取，标注"可能过窄，建议HR确认是否真为硬性" |
| 偏好特定地区户籍 | ⚠️ 可能不合理 | 提取并标注风险，让HR决策 |
| 任何与候选人性别相关的模式 | ❌ 跳过 | 不提取，不呈现 |
| 任何与候选人年龄相关的模式 | ❌ 跳过 | 不提取，不呈现 |

**注意**：合理性判断的目的是帮助 HR 做出知情决策，不是替 HR 决策。标注风险后，最终采用与否由 HR 在 B-S4 确认时决定。

### Confidence Calibration

| Confidence | Criteria |
|------------|---------|
| **高** | 6+ data points consistently support the pattern; pattern is clear and unambiguous |
| **中** | 3-5 data points; pattern exists but has exceptions |
| **低** | 1-2 data points; could be coincidental; sample too small to conclude |

### Output: extracted-conditions.md

Write to `B-conditions/extracted-conditions.md`. Format:

```markdown
# 提取的隐藏用人条件

> 以下条件从用人部门实际反馈行为中提取，尚未经 HR 确认。
> 每条标注了数据置信度和合理性判断，供 HR 逐条审核。

## 条件 1
- **描述：**偏好有大厂实习经历
- **置信度：**高（基于 8 条反馈中 6 条体现此倾向）
- **合理性判断：**合理 — 大厂实习通常意味着更系统的工程训练
- **支撑案例：**
  - 张三（通过）：有 XX 科技实习
  - 李四（通过）：有 YY 公司实习
  - 钱七（不通过）：无知名公司经历
  - 孙八（不通过）：仅有小型工作室经历

## 条件 2
- **描述：**不接受频繁跳槽（1年内换2次以上）
- **置信度：**中（基于 4 条反馈中 3 条体现此倾向）
- **合理性判断：**合理 — 稳定性是常见用人偏好
- **支撑案例：**
  - ...

（性别/年龄相关模式已在提取阶段过滤，不会出现在此列表中）
```

### B-S3 Completion

- Write extracted-conditions.md
- Append to B.log.md: number of conditions extracted, confidence distribution

---

## B-S4: HR Confirmation

### Interactive Confirmation Flow

Present each extracted condition to HR **one by one** (or in small batches if there are many). For each condition, HR can:

| Action | What Happens |
|--------|-------------|
| **接受 (Accept)** | Condition goes into confirmed list as-is |
| **修改 (Modify)** | HR adjusts the wording, threshold, or scope. Updated version goes into confirmed list. |
| **拒绝 (Reject)** | Condition is recorded as rejected with HR's reason |

### Presentation Format

When presenting to HR, show:
1. The condition description
2. Confidence level and supporting evidence summary
3. Reasonableness assessment (especially flag any potentially problematic ones)
4. Ask: "接受 / 修改 / 拒绝？"

If HR modifies a condition, record both the original and the modified version.

### Output: confirmed-conditions.md

After all conditions are reviewed, write `B-conditions/confirmed-conditions.md`:

```markdown
# 已确认的隐藏用人条件

> HR 已逐条审核，以下为最终确认结果。
> 已确认的条件将作为功能C筛选的输入之一。

## 接受的条件

### 1. 偏好有大厂实习经历
- **类型：**加权偏好（非硬性红线）
- **权重：**中等
- **来源：**功能B 提取，{date} HR确认

### 2. 不接受频繁跳槽
- **类型：**加权偏好
- **权重：**较高
- **来源：**功能B 提取，{date} HR确认
- **HR修改：**将"1年内换2次以上"改为"2年内换3次以上"

## 拒绝的条件

### 3. 偏好男性候选人
- **拒绝原因：**HR 判断为偏见，不应作为筛选条件
```

### B-S4 Completion

- Write confirmed-conditions.md
- Append to B.log.md: accepted/rejected/modified counts
- Notify: "功能B 完成。已确认的条件可用于功能C筛选。"
