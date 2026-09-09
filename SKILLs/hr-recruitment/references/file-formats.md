# File Formats — Complete Templates

This document contains the exact output templates for every file the skill produces. Read it whenever you need to write an output file.

## Table of Contents

1. [analysis.md (Per-Resume)](#analysismd)
2. [A.summary.md](#asummarymd)
3. [A.alerts.md](#aalertsmd)
4. [A.log.md](#alogmd)
5. [jd-deep-analysis.md](#jd-deep-analysismd)
6. [jd-analysis-confirmed.md](#jd-analysis-confirmedmd)
7. [hiring-context-analysis.md](#hiring-context-analysismd)
8. [comprehensive-requirements.md](#comprehensive-requirementsmd)
9. [D.log.md](#dlogmd)
10. [feedback-parsed.md](#feedback-parsedmd)
11. [extracted-conditions.md](#extracted-conditionsmd)
12. [confirmed-conditions.md](#confirmed-conditionsmd)
13. [screening-criteria.md](#screening-criteriamd)
14. [screening-result.md](#screening-resultmd)
15. [ledger.md](#ledgermd)

---

## analysis.md

Each resume produces one `{filename}.analysis.md` file in `A-parse/`. This is the **single output file per resume**, containing two sections written by two different writers:

- **Section 1 — 原始文本**（代码写入）：Python 提取完文字后，立即用代码（文件 I/O）写入。不经 LLM 处理，速度快，零 token 消耗。
- **Section 2 — 解析报告**（LLM写入）：LLM 读取原始文本，追加 A-S2～A-S5 的完整分析内容。

**写入顺序（严格遵守）：**
1. Python 代码提取文字 → 代码写入 Section 1 到文件
2. LLM 读文件 → 追加 Section 2

```markdown
## 原始文本

- 源文件：resumes/{filename}
- 提取方式：{pdf解析 | docx解析 | 视觉直接处理(PDF) | 视觉直接处理}
- 提取时间：{YYYY-MM-DD HH:MM}
- 字符数：{N}

---

{从 PDF/DOCX/图片中提取的完整全文，一字不删，不格式化，不改动}

---

<!-- LLM 分析内容从此处开始 -->

# 简历解析报告 — {姓名}

## 解析元信息
- 处理时间：{timestamp}

---

## 基本信息
- 姓名：{value} [置信度：{高|中|低}{低时附原因}]
- 性别：{value} [置信度：{高|中|低}{低时附原因}]
- 出生年月：{value} [置信度：{高|中|低}{低时附原因}]
- 手机：{value} [置信度：{高|中|低}{低时附原因}]
- 邮箱：{value} [置信度：{高|中|低}{低时附原因}]

## 教育背景
### 教育经历 1（{本科/硕士/博士}） [整体置信度：{高|中|低}{低时附原因}]
- 院校：{value} [置信度：{level}]
- 院校（归一化）：{官方全称}{（国家简称，海外高校）}
- 院校层次：{国内：985 / 211 / 双一流 | 海外：QS={rank}}
- 学历：{本科 / 硕士 / 博士 / 专科} [置信度：{level}{中/低时附说明}]
- 专业：{value} [置信度：{level}]
- 时间：{start} - {end} [置信度：{level}]
- 学制：{X年制} [置信度：{level}]
- 校验结果：{✅ 信息一致 | ⚠️ {具体问题}}

### 教育经历 2（{本科/硕士/博士}） [整体置信度：{level}]
- ...（结构同上，每段独立评分）

### 学历独立评价
- 本科：{院校（归一化）} | {层次} | {学制} | 含金量：{评价}
- 硕士：{院校（归一化）} | {层次} | {学制} | 含金量：{评价}，相对本科：{提升/持平/下降}
- 博士：{如有}
- 综合评价：{一句话总结学历含金量}

## 工作/实习经历
### 经历 1 [整体置信度：{level}]
- 公司：{value} [置信度：{level}]
- 职位：{value} [置信度：{level}]
- 时间：{start} - {end} [置信度：{level}]
- 职责描述：[置信度：{level}{附说明}]
  > {原文引用或整理后的描述}
  > {可多行}

### 经历 2 [整体置信度：{level}]
- ...（结构同上，每段独立评分）

## 项目经历
### 项目 1 [整体置信度：{level}]
- 项目名：{value} [置信度：{level}]
- 角色：{value} [置信度：{level}]
- 技术栈：{value} [置信度：{level}]
- 成果描述：[置信度：{level}{附说明}]
  > {描述内容}

## 技能清单
- {技能1} [置信度：{level} — {佐证说明或缺乏佐证说明}]
- {技能2} [置信度：{level} — {说明}]
- ...

## 时间线
[置信度：{level} — {说明}]

| 时间段 | 内容 | 类型 | 备注 |
|--------|------|------|------|
| {YYYY.MM – YYYY.MM} | {院校/公司} | {本科/硕士/实习/全职/空窗} | {说明或 —} |
| {YYYY.MM – YYYY.MM} | {院校/公司} | {类型} | {或：⚠️ 空窗未解释} |

---

## 注水风险评估
- **总体可信度：{score}/100**

| 维度 | 风险等级 | 说明 |
|------|---------|------|
| 时间线一致性 | {✅ 无风险 | ⚠️ 低风险 | ⚠️ 中风险 | 🔴 高风险} | {说明} |
| 经历深度 | {level} | {说明} |
| AI 生成痕迹 | {level} | {说明} |
| 学历疑点 | {level} | {说明} |
| 经历合理性 | {level} | {说明} |

具体风险点：
1. [{level}-{维度}] {具体描述}
2. [{level}-{维度}] {具体描述}
（如无风险点，写"无具体风险点"）

---

## 质量评分（纯简历维度）

### 教育背景明细分（计算过程透明）
| 阶段 | 院校 | 层次 | 分数 | 权重/说明 |
|------|------|------|------|----------|
| 本科 | {院校名（归一化）} | {985/211/双一流/普通/QS=XX} | {n} | base分，权重65% |
| 硕士 | {院校名（归一化）} | {985/211/双一流/普通/QS=XX} | +{n} | 加分（跨档+2/同档+1/低档+0），权重35% |
| 博士 | {如有} | {层次} | +{n} | 独立加分（有博士学位即+3） |
| **教育总分** | — | — | **{total}/20** | 上限20 |

| 维度 | 分数 | 评价 |
|------|------|------|
| 教育背景 | {n}/20 | {一句话评价，包含本硕关系分析} |
| 经历丰富度 | {n}/20 | {一句话评价} |
| 技能覆盖 | {n}/20 | {一句话评价} |
| 稳定性 | {n}/20 | {一句话评价} |
| 写作质量 | {n}/20 | {一句话评价} |
| **综合** | **{total}/100** | — |

**总评**：{2-3句话总结，概括优势和不足，给出具体建议关注点}

---

## 误分类检测
- {✅ 无异常，简历内容与当前JD方向一致 | ⚠️ 疑似误分类：{具体原因}}
```

---

## A.summary.md

Generated after ALL resumes are processed.

```markdown
# 功能A 汇总报告

## 处理概览
- 简历总数：{total}
- 有效处理：{valid}
- 提取失败：{failed}（{列出文件名和原因}）
- 疑似重复：{n}组（详见 A.alerts.md）
- 疑似误分类：{n}份（详见 A.alerts.md）

## 质量排名

| 排名 | 姓名 | 综合分 | 教育 | 经历 | 技能 | 稳定性 | 写作 | 注水可信度 | 关注点 |
|------|------|--------|------|------|------|--------|------|-----------|--------|
| 1 | {name} | {score} | {n} | {n} | {n} | {n} | {n} | {credibility} | {or —} |
| 2 | {name} | {score} | {n} | {n} | {n} | {n} | {n} | {credibility} | {note} |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

## 高风险简历（注水可信度 < 60）

| 姓名 | 可信度 | 主要风险点 |
|------|--------|-----------|
| {name} | {score} | {risk points summary} |

（如无高风险简历，写"无高风险简历"）

## 低置信度字段汇总（需 HR 关注）

| 姓名 | 字段 | 置信度 | 原因 |
|------|------|--------|------|
| {name} | {field} | 低 | {reason} |

（如无低置信度字段，写"无需特别关注的低置信度字段"）

## 处理漏斗
源文件 {total} → 提取成功 {extracted} → 有效解析 {valid} → 去重后 {deduped}
其中：高风险 {n} 份 / 低置信度字段 {n} 处需关注 / 疑似误分类 {n} 份
```

---

## A.alerts.md

```markdown
# 功能A — 待HR处理事项

## 疑似误分类（A-S5 发现）
| 文件 | 原因 | 建议 |
|------|------|------|
| {filename} | {reason} | 确认是否移出当前目录 |

（如无，写"无疑似误分类"）

## 疑似重复（去重发现）
| 组 | 涉及文件 | 匹配方式 | 置信度 |
|----|---------|---------|--------|
| #1 | {file1}, {file2} | {精确（姓名+手机）| 模糊（条件）} | {确认重复 | 疑似，需确认} |

（如无，写"无疑似重复"）

## 提取失败
| 文件 | 原因 |
|------|------|
| {filename} | {error description} |

（如无，写"无提取失败"）
```

---

## A.log.md

```markdown
# 功能A 处理日志

## [{timestamp}] 启动
- 扫描 resumes/ 目录，发现 {n} 个文件
- 类型分布：PDF {n}, DOCX {n}, PNG {n}, JPG {n}
- 复制到 A-parse/，跳过已存在的 {n} 个

## [{timestamp}] #{seq} {filename}
- A-S1 文本提取：{method}，{成功|失败}，{pages}页，约 {chars} 字
- A-S2 信息抽取：提取到 {fields summary}
  - 低置信度字段 {n} 个：{list}
- A-S3 注水检测：可信度 {score}/100
  - 风险点 {n} 个：{summary}
- A-S4 质量评分：{score}/100（教育{n} 经历{n} 技能{n} 稳定性{n} 写作{n}）
- A-S5 误分类检测：{无异常 | ⚠️ description}
- 输出：A-parse/{filename}.analysis.md

## [{timestamp}] ⚠️ #{seq} {filename}
（异常情况用 ⚠️ 标记，格式同上但附错误详情）

## [{timestamp}] 全部处理完成
- 有效处理：{n}/{total}
- 跨文件去重：发现 {n} 组疑似重复 → 记入 alerts
- 生成 A.summary.md
- 生成 A.alerts.md（{n}类事项共 {n} 条）
- 统一报告 HR
```

---

## jd-deep-analysis.md

D-S1 的原始分析输出，尚未经 HR 确认。

```markdown
# JD 深度解析 — {岗位名称}

## 解析元信息
- 源文件: jd.md
- 解析时间: {YYYY-MM-DD HH:MM}
- 状态: ⚠️ 待 HR 确认（此为 LLM 初始分析，HR 确认后请参见 jd-analysis-confirmed.md）

---

## 岗位类型判定

### 招聘类型: {实习生 / 校招应届生 / 社招}
- 判断依据: {JD 中的关键词和上下文}

### 岗位性质: {技术研发 / 产品 / 运营 / 市场推广 / 管理 / 职能支持 / 创意设计}
- 判断依据: {JD 中的职责描述}

### 核心使命（推理）
{1-2 句话描述这个岗位最核心的工作是什么}

---

## 逐条解析

### 🔴 刚需条件

#### 刚需 #{N}: {条件描述}
- JD 原文: "{原文}"
- 分类理由: {为什么判定为刚需}
- 置信度: {高/中/低}
{低置信度或中置信度时附：}
- ⚠️ 不确定说明: {不确定原因}
- 需要 HR 确认: {具体要确认什么}

#### 刚需 #{N+1}: ...

---

### 🟡 等效替代组

#### 等效替代组 #{N}: {底层能力名称}
- JD 原文: "{原文描述}"
- 底层能力需求: {这条要求实际测试的是什么能力}
- 岗位类型影响: {当前岗位类型下的特殊考量}
- 可接受方案（满足任一即可）:
  1. {方案A — JD 原文要求} — {说明}
  2. {方案B} — {为什么可以替代}
  3. {方案C} — {说明}
- 不可替代场景: {什么情况下只有原始要求才行}
- 替代条件: {在什么前提下替代方案才成立}
- 置信度: {高/中/低} — {说明}

#### 等效替代组 #{N+1}: ...

---

### 🔵 次要条件

#### 次要 #{N}: {条件描述}
- JD 原文: "{原文}"
- 分类理由: {为什么是次要而非刚需}
- 建议权重: {高/中/低}

#### 次要 #{N+1}: ...

---

### ⚪ 加分项

#### 加分 #{N}: {条件描述}
- JD 原文: "{原文}"
- 分类理由: {为什么是加分项}

#### 加分 #{N+1}: ...

---

### 🔍 隐含需求（JD 未写但逻辑上必须）

#### 隐含 #{N}: {需求描述}
- 推理来源: {从 JD 的什么内容推理出来}
- 推理逻辑: {推理过程}
- 建议分类: {刚需/次要/加分}

#### 隐含 #{N+1}: ...

---

## 解析统计
- 刚需条件: {n} 条
- 等效替代组: {n} 组
- 次要条件: {n} 条
- 加分项: {n} 条
- 隐含需求: {n} 条
- 不确定项: {n} 条（需 HR 重点确认）
```

---

## jd-analysis-confirmed.md

D-S2 HR 确认后的 JD 分析结果。格式与 jd-deep-analysis.md 基本相同，但增加 HR 确认标记和变更记录。

```markdown
# JD 深度解析（HR 已确认） — {岗位名称}

## 确认信息
- 基于: jd-deep-analysis.md
- HR 确认时间: {YYYY-MM-DD HH:MM}
- 确认操作统计: 确认 {n} 条 / 调整 {n} 条 / 新增 {n} 条 / 删除 {n} 条

---

## 岗位类型判定 [HR 确认: ✅ / ⚠️ 已调整]

### 招聘类型: {实习生 / 校招应届生 / 社招}
- 判断依据: {依据}
{如 HR 调整了类型：}
- HR 调整: 原判定 → {原类型}，HR 修正为 → {新类型}，原因: {HR 说明}

### 岗位性质: {value}
### 核心使命: {value}

---

## 逐条解析（HR 已确认）

### 🔴 刚需条件

#### 刚需 #{N}: {条件描述} [HR: ✅]
- JD 原文: "{原文}"
- 分类理由: {理由}

#### 刚需 #{N+1}: {条件描述} [HR: ⚠️ 已调整]
- JD 原文: "{原文}"
- 原始分类: {次要}
- HR 调整为: 刚需
- HR 说明: "{HR 的解释}"

#### 刚需 #{N+2}: {条件描述} [HR: ➕ 新增]
- 来源: HR 补充
- HR 说明: "{HR 的解释}"

（等效替代组 / 次要条件 / 加分项 / 隐含需求 格式同上，每条标注 [HR: ✅ / ⚠️ 已调整 / ➕ 新增]）

---

## 变更记录

| 序号 | 操作 | 条目 | 变更内容 |
|------|------|------|---------|
| 1 | 确认 | 刚需 #1 | 保持原样 |
| 2 | 调整分类 | 原次要 #3 → 刚需 #4 | HR 认为这是硬性要求 |
| 3 | 新增 | 刚需 #5 | HR 补充: "必须能出差" |
| 4 | 删除 | 原加分 #2 | HR 认为不是真正的要求 |
| 5 | 修改描述 | 等效替代组 #1 | HR 增加了替代方案: "Tableau 也可以" |
```

---

## hiring-context-analysis.md

D-S3 的上下文材料分析输出。仅在 HR 提供了补充材料时生成。

```markdown
# 用人部门上下文分析 — {岗位名称}

## 分析元信息
- 分析时间: {YYYY-MM-DD HH:MM}
- 输入材料:
  - {材料1: 面试官简历 — context/张三简历.pdf}
  - {材料2: 团队构成 — HR 口述}
  - ...

---

## 材料 1: 面试官/主管分析 — {姓名}

### 背景摘要
- 教育: {学历概要}
- 职业路径: {关键经历概要}
- 技术栈/专长: {概要}

### 推理结果

#### 推理 #{N}: {偏好描述}
- 推理方向: {偏好相似 / 偏好互补 / 其他}
- 推理依据: {从面试官简历的什么特征推出}
- 推理逻辑: {详细推理过程}
- 反向假设: {如果反过来想，也可能是...}
- 置信度: {高/中/低} — {说明}
- 转化为条件: {如果 HR 确认，会变成什么样的筛选条件}
- HR 确认: {✅ 采纳 / ❌ 不采纳 / ⚠️ 调整: {调整内容}}

#### 推理 #{N+1}: ...

---

## 材料 2: 团队构成分析

### 团队概况
- 规模: {n} 人
- 构成: {角色分布概要}

### 推理结果
（格式同上）

---

## 材料 3: 业务方向分析 / 主管口头偏好
（格式同上）

---

## ⚠️ 风险标注

### 风险 #{N}: {风险描述}
- 类型: {潜在偏见 / JD 与实际不符 / 过度要求}
- 说明: {详细解释}
- 建议: {如何处理}

（如无风险，写"无风险标注"）

---

## 推理统计
- 分析材料数: {n}
- 生成推理条目: {n}
- HR 采纳: {n} / 不采纳: {n} / 调整: {n}
- 风险标注: {n}
```

---

## comprehensive-requirements.md

D-S4 的最终产出。合并 JD 分析 + 上下文推理，经 HR 最终确认。**这是下游 Module A/B/C 的增强输入源。**

```markdown
# 综合岗位需求 — {岗位名称}

## 生成信息
- 基于 JD: jd.md
- D-S2 确认时间: {YYYY-MM-DD HH:MM}
- 上下文材料: {有（{材料列表}）/ 无}
- D-S4 生成时间: {YYYY-MM-DD HH:MM}
- HR 最终确认: {YYYY-MM-DD HH:MM}

---

## 一、岗位画像

- 岗位名称: {value}
- 招聘类型: {实习生 / 校招应届生 / 社招}
- 岗位性质: {技术研发 / 产品 / 运营 / 市场推广 / 管理 / 职能支持 / 创意设计}
- 核心使命: {1-2 句话}
- 工作地点: {value}
- 到岗要求: {value}
- 其他基本信息: {value}

---

## 二、刚需条件（不满足则无法胜任 → Module C 硬性过滤）

### 刚需 1: {条件描述}
- 来源: {JD / HR补充 / 隐含推理}
- JD 原文: {如有}
- 分析说明: {分类理由}
- HR 确认: ✅

### 刚需 2: {条件描述}
...

---

## 三、等效替代组（满足组内任一方案即可 → Module C 组内 OR 硬性过滤）

### 替代组 1: {底层能力需求}
- JD 原文: "{原文描述}"
- 底层能力: {实际需要的能力}
- 可接受方案:
  1. {方案A} — {说明}
  2. {方案B} — {说明}
  3. {方案C} — {说明}
- 不可替代场景: {什么情况下只能是特定方案}
- HR 确认: ✅ / 已调整: {调整内容}

### 替代组 2: ...

---

## 四、次要条件（有则更好 → Module C 软性评分，权重：中）

### 次要 1: {条件描述}
- 来源: {source}
- 说明: {why secondary}
- 权重建议: {高/中/低}

### 次要 2: ...

---

## 五、加分项（锦上添花 → Module C 软性评分，权重：低）

### 加分 1: {条件描述}
- 来源: {source}
- 说明: {why bonus}

### 加分 2: ...

---

## 六、用人部门偏好（来自 D-S3 上下文推理，HR 已确认 → Module C 软性评分）

### 偏好 1: {偏好描述}
- 置信度: {高/中/低}
- 来源: {面试官简历推理 / 团队构成推理 / 业务方向推理 / HR口述}
- 推理过程: {简要推理逻辑}
- HR 确认: ✅
- 建议权重: {高/中/低}

### 偏好 2: ...

（如果 D-S3 未运行或 HR 未提供材料，写"未提供用人部门上下文材料，无额外偏好"）

---

## 七、风险提醒

### ⚠️ 风险 1: {风险描述}
- 类型: {JD与实际需求偏差 / 潜在偏见 / 矛盾条件 / 过度要求}
- 说明: {详细解释}
- 建议: {如何处理}

（如无风险，写"无风险提醒"）

---

## 条件汇总

| 类别 | 数量 | Module C 映射 |
|------|------|--------------|
| 刚需 | {n} | 硬性过滤（不满足 = 淘汰） |
| 等效替代 | {n} 组 | 硬性过滤（组内 OR） |
| 次要 | {n} | 软性评分（权重中） |
| 加分 | {n} | 软性评分（权重低） |
| 用人偏好 | {n} | 软性评分（权重由 HR 确认） |
| 风险提醒 | {n} | 供 HR 参考，不直接影响筛选 |
```

---

## D.log.md

```markdown
# Module D 处理日志

## [{timestamp}] D-S1 JD 智能解析
- 源文件: jd.md
- 岗位类型判定: {招聘类型} × {岗位性质}
- 解析条目数: 刚需 {n} / 等效替代 {n} 组 / 次要 {n} / 加分 {n} / 隐含 {n}
- 不确定项: {n}
- 输出: D-analysis/jd-deep-analysis.md

## [{timestamp}] D-S2 HR 确认
- 确认 {n} 条 / 调整 {n} 条 / 新增 {n} 条 / 删除 {n} 条
- 岗位类型确认: {✅ 无变化 / ⚠️ 已调整}
- 输出: D-analysis/jd-analysis-confirmed.md

## [{timestamp}] D-S3 用人部门上下文（可选）
- 输入材料: {材料列表}
- 推理条目: {n}
- HR 采纳 {n} / 不采纳 {n} / 调整 {n}
- 风险标注: {n}
- 输出: D-analysis/hiring-context-analysis.md

## [{timestamp}] D-S4 综合需求生成
- 合并来源: D-S2 + D-S3
- 最终条件数: 刚需 {n} / 等效替代 {n} 组 / 次要 {n} / 加分 {n} / 偏好 {n}
- HR 最终确认: ✅
- 输出: D-analysis/comprehensive-requirements.md
- Module D 完成
```

---

## feedback-parsed.md

See `references/module-B.md` section "Output: feedback-parsed.md" for the exact template.

## extracted-conditions.md

See `references/module-B.md` section "Output: extracted-conditions.md" for the exact template.

## confirmed-conditions.md

See `references/module-B.md` section "Output: confirmed-conditions.md" for the exact template.

---

## screening-criteria.md

```markdown
# 筛选标准 v{n}
- 创建时间：{timestamp}
- 基于版本：{v{n-1} + description of changes | 首次创建}
- 变更说明：{what changed, or "首次创建"}
- JD 来源：{comprehensive-requirements.md | jd.md}

## 一、硬性条件（不满足则淘汰）

- {条件 1} [来源：JD / comprehensive-requirements.md]
- {条件 2} [来源：HR配置]
- {条件 3（等效替代组）：满足以下任一即可} [来源：JD / comprehensive-requirements.md]
  - 方案A：{description}
  - 方案B：{description}

（如无硬性条件，写"无硬性条件"）

## 二、软性评分条件

### 权重：高
- {条件 1} [来源：HR配置]

### 权重：中
- {条件 1} [来源：JD / comprehensive-requirements.md]
- {条件 2} [来源：Module B，基于{n}条反馈，HR已确认]

### 权重：低
- {条件 1} [来源：JD / comprehensive-requirements.md]
- {条件 2} [来源：HR配置]

（如无软性条件，写"无软性条件"）

## 三、条件来源摘要
- JD/综合需求来源：硬性 {n} 条 / 软性 {n} 条
- HR 直接配置：硬性 {n} 条 / 软性 {n} 条
- Module B 隐藏条件：软性 {n} 条
（如 Module B 未运行，写"Module B 未运行，无隐藏条件"）

## v{n-1} → v{n} 变更记录
- [新增] {description}
- [修改] {description}
- [删除] {description}

（首次创建时写"首次创建，无变更记录"）
```

---

## screening-result.md

```markdown
# 筛选结果 v{n}

## 筛选概览
- 输入简历数：{total}（来自功能A有效解析结果）
- 硬性过滤淘汰：{rejected}
- 信息不足待判：{insufficient}
- 进入软性评分：{scored}
- 使用标准版本：v{n}

## 筛选漏斗
功能A有效 {total} → 硬性过滤通过 {passed} → 排序完成 {ranked}
淘汰 {rejected}（{breakdown by reason}）
信息不足 {insufficient}（待HR判断）

## 排名列表

| 排名 | 姓名 | 硬性 | JD匹配 | HR偏好 | 隐藏条件 | 综合筛选分 | A质量分 | 注水可信度 | 淘汰/关注点 |
|------|------|------|--------|--------|---------|-----------|---------|-----------|------------|
| 1 | {name} | ✅ | {score} | {score} | {score} | {total} | {a_score} | {credibility} | {or —} |
| 2 | {name} | ✅ | {score} | {score} | {score} | {total} | {a_score} | {credibility} | {note} |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |

## 淘汰列表

| 姓名 | 淘汰条件 | 具体原因 |
|------|---------|---------|
| {name} | {which hard condition} | {specific reason} |

## 信息不足列表

| 姓名 | 不足字段 | 无法判断的条件 | 建议 |
|------|---------|--------------|------|
| {name} | {field} (置信度低) | {which hard condition} | {suggestion} |

（如无淘汰/信息不足，相应写"无"）
```

---

## ledger.md

Designed for copy-paste into Feishu / Shimo / Excel. Keep it flat and simple.

```markdown
# 筛选台账 v{n}

| 序号 | 姓名 | 学历 | 院校 | 专业 | 毕业时间 | 实习经历 | 综合筛选分 | 注水可信度 | 结果 | 备注 |
|------|------|------|------|------|---------|---------|-----------|-----------|------|------|
| 1 | {name} | {degree} | {school} | {major} | {grad_date} | {companies} | {score} | {credibility} | {通过|淘汰} | {note or —} |
| 2 | {name} | {degree} | {school} | {major} | {grad_date} | {companies} | {score} | {credibility} | {result} | {note} |
| ... | ... | ... | ... | ... | ... | ... | ... | ... | ... | ... |
```

Notes for ledger:
- Include ALL candidates (passed and rejected) in one table
- Rejected candidates show "淘汰" in result column with reason in notes
- Sort by: passed candidates ranked by score first, then rejected candidates
- Keep "实习经历" column brief: just company names separated by /
