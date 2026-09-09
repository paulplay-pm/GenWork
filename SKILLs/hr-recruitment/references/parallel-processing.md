# 并行处理模式 — 完整参考

本文档定义了简历解析（Module A）的批量并行处理架构。**每批 4 份简历，最多 3 个子 agent 同时运行，主 agent 负责调度、审核和结果汇总。**

---

## 触发条件

| 简历数量 | 处理方式 |
|---------|---------|
| ≤ 4 份 | 主 agent 直接串行处理（无需批次目录） |
| > 4 份 | 启动并行批次模式（本文档定义的流程）|

---

## 整体架构

```
主 agent
  ├── 1. 分批：每批 4 份简历 → 创建 batch1/ batch2/ batch3/...
  │         每个 batch 目录内：简历副本 + jd.md + comprehensive-requirements.md（如存在）
  │
  ├── 2. 滑动窗口调度（最多 3 个子 agent 同时运行）
  │   ├── 启动 batch1 子 agent ──┐
  │   ├── 启动 batch2 子 agent ──┤ 同时运行，最多 3 个
  │   ├── 启动 batch3 子 agent ──┘
  │   │
  │   │   [某 batch 完成后]
  │   │   ├── 主 agent 审核该 batch 的输出
  │   │   │   ├── 审核通过 → 将结果复制到 A-parse/ 根目录 → 启动下一个 batch
  │   │   │   └── 审核失败 → 记录失败项，标记 ❌，继续下一个 batch
  │   │   └── [维持最多 3 个并发]
  │   │
  ├── 3. 所有 batch 处理完毕
  │   ├── 对 A-parse/ 根目录的全部结果执行去重检测
  │   ├── 生成 A.summary.md 和 A.alerts.md
  │   └── 向 HR 汇报整批处理结果
  │
  └── 后续：视情况进行偏好挖掘 → 候选人筛选
```

---

## 目录结构

```
skill-output/A-parse/
│
├── batch1/                                  ← 子 agent 1 的独立工作空间
│   ├── jd.md                                ← JD 副本（主 agent 复制）
│   ├── comprehensive-requirements.md        ← 综合需求副本（如存在）
│   ├── 张三.pdf                             ← 简历副本
│   ├── 李四.pdf
│   ├── 王五.pdf
│   ├── 赵六.pdf
│   ├── 张三.pdf.analysis.md                 ← 子 agent 输出（审核前）
│   ├── 李四.pdf.analysis.md
│   └── ...
│
├── batch2/                                  ← 子 agent 2 的独立工作空间
│   └── ...
│
├── batch3/
│   └── ...
│
├── 张三.pdf                                 ← 最终简历副本（主 agent 审核后复制）
├── 张三.pdf.analysis.md                     ← 最终分析结果（审核通过后复制）
├── 李四.pdf
├── 李四.pdf.analysis.md
├── ...
│
├── A.worklist.md                            ← 主 agent 维护的全局进度表
├── A.log.md                                 ← 全局日志
├── A.summary.md                             ← 所有简历处理完后生成
└── A.alerts.md                              ← 异常汇总
```

---

## 主 agent 执行步骤

### Step 1：分批

```python
# 将所有简历按每批 4 份分组
resumes = [所有 resumes/ 中的文件列表]
batch_size = 4
batches = [resumes[i:i+4] for i in range(0, len(resumes), 4)]
# 共 ceil(N/4) 个批次
```

对每个批次：
1. 创建目录 `A-parse/batch{n}/`
2. 将该批次的 4 份简历复制进去
3. 复制 `jd.md` → `A-parse/batch{n}/jd.md`
4. 若 `comprehensive-requirements.md` 存在，复制 → `A-parse/batch{n}/comprehensive-requirements.md`

### Step 2：滑动窗口调度

维护一个"运行中"队列，上限 3 个子 agent：

```
待处理队列：[batch1, batch2, batch3, batch4, batch5, ...]
运行中：最多 3 个

循环：
  while 待处理队列非空 or 运行中非空：
    while len(运行中) < 3 and 待处理队列非空：
      取出下一个 batch → 启动子 agent → 加入运行中
    等待任意一个子 agent 完成
    对完成的 batch 执行审核（见 Step 3）
    从运行中移除该 batch
```

### Step 3：审核子 agent 输出

子 agent 完成后，主 agent 对该 batch 目录执行以下检查：

**检查项（逐份简历）：**
1. `{filename}.analysis.md` 文件是否存在
2. 文件是否包含 `## 原始文本` 节（代码写入的部分）
3. 文件是否包含 `# 简历解析报告` 节（LLM 分析部分）
4. 文件大小是否合理（非空、非极小）

**审核结果处理：**

| 情况 | 处理 |
|------|------|
| 该简历 analysis.md 通过所有检查 | 将 `{filename}` 和 `{filename}.analysis.md` 复制到 `A-parse/` 根目录；在 A.worklist.md 中标记 ✅ |
| analysis.md 缺失或不完整 | 在 A.worklist.md 中标记 ❌，原因记入 A.log.md；记入 A.alerts.md |
| 整个 batch 全部失败 | 向 HR 汇报该批次失败，询问是否重试 |

### Step 4：batch 目录清理

审核完成后，batch 目录可保留（方便调试）或删除。**默认保留**，全部处理完毕后统一提示 HR 是否清理。

---

## 子 agent 规范

### ⚠️ 模型一致性

子 agent **必须与主 agent 使用相同的模型和配置**。原因：
- A-S2～A-S5 的推理质量（院校归一化、水分分析、质量评分）强依赖模型能力
- 不同模型处理的简历之间评分标准不一致，跨简历对比结论不可信

在启动子 agent 时，**显式指定与当前主 session 相同的模型 ID**。

### 子 agent 工作边界

每个子 agent 的任务范围：
- **工作目录**：`A-parse/batch{n}/`（仅在此目录内操作）
- **读取**：批次目录内的简历文件 + jd.md + comprehensive-requirements.md
- **写入**：批次目录内的 `{filename}.analysis.md`
- **不访问**：A-parse/ 根目录、其他 batch 目录、A.worklist.md（由主 agent 维护）
- **不调用**：`track_complete.py`（由主 agent 在审核后统一更新）

### 子 agent 启动指令模板

```
你是 hr-recruitment-skill 的简历解析工作进程。

工作目录：{job-dir}/skill-output/A-parse/batch{n}/
SKILL 目录：{SKILL_DIR}

任务：处理本目录中的所有简历文件，每份按顺序逐个处理。

本目录包含的简历文件：
{列出文件名列表}

JD 文件：batch{n}/jd.md
综合需求文件：batch{n}/comprehensive-requirements.md（如存在，A-S5 优先使用）

每份简历的处理流程（按顺序）：
1. A-S1：提取文本（pypdf / python-docx / 视觉处理），用代码将原始文本写入 {filename}.analysis.md 的第一节
2. A-S2：LLM 读取 analysis.md，追加信息提取 + 置信度 + 院校归一化
3. A-S3：追加水分检测结果（可信度评分 0-100）
4. A-S4：追加质量评分（5 维度 × 20 = 100 满分）
5. A-S5：追加误分类检测（对照本目录中的 JD/综合需求）

输出文件写入：batch{n}/{filename}.analysis.md

注意事项：
- 严禁访问 batch{n}/ 以外的目录
- 严禁 PDF 转图片或本地 OCR
- 逐份顺序处理，完成一份再处理下一份
- 每完成一份，在回复中报告进度："已完成 {n}/{total}：{filename}（质量分 {q}，可信度 {c}）"

全部完成后回复：
"batch{n} 完成：{total} 份，成功 {ok} 份，失败 {failed} 份
{失败文件列表及原因（如有）}"
```

---

## 失败处理

### 子 agent 完全失败（无任何输出）

```
判断条件：子 agent 完成后，batch 目录内无任何 analysis.md 文件

处理方式：
  1. 记录失败，不重试（避免无限循环）
  2. 将该 batch 的所有简历标记为 ❌（在 A.worklist.md 中）
  3. 记入 A.alerts.md："batch{n} 子 agent 未产生任何输出，{列出文件名}"
  4. 继续处理下一个 batch
```

### 部分简历失败

```
判断条件：batch 中部分 analysis.md 缺失或不完整

处理方式：
  1. 通过审核的简历 → 复制到根目录，标记 ✅
  2. 未通过审核的简历 → 标记 ❌，原因记入 A.alerts.md
  3. 继续下一个 batch，不重试失败项
```

### 批量失败预警

```
如果连续 2 个 batch 全部失败：
  立即暂停，向 HR 汇报：
  "连续 2 批次（batch{n} 和 batch{n+1}）的子 agent 均未产生有效输出，
   疑似环境问题。建议检查 pdf skill / docx skill 是否正常。
   当前已完成 {completed} 份，剩余 {remaining} 份待处理。
   是否切换为串行模式继续？"
```

---

## A.worklist.md 在并行模式下的职责

主 agent 独占维护 A.worklist.md，子 agent 不写入：

| 时机 | 主 agent 动作 |
|------|-------------|
| 分批前 | 初始化所有简历为 ⏳ |
| 某简历审核通过 | 更新为 ✅，记录质量分、可信度、备注 |
| 某简历审核失败 | 更新为 ❌，记录原因 |
| 每隔 3 个 batch 完成 | 向 HR 发送进度报告 |

---

## 进度报告（面向 HR）

每完成 3 个 batch，主 agent 向 HR 汇报：

> 📊 **进度更新**：已完成 {n}/{total} 份（{pct}%）。
> 本轮完成：batch{x}（{ok} 份成功）、batch{y}（{ok} 份成功）、batch{z}（{ok} 份成功）
> 失败：{failed} 份（详见 A.alerts.md）
> 当前运行中：batch{a}、batch{b}
> 剩余待处理：{remaining} 份

---

## 脚本支持

分批操作由主 agent 用 Python 代码直接完成，无需调用 `parallel_split.py`（该脚本已弃用）。

目录创建和文件复制使用标准 Python：

```python
import shutil, os

batch_dir = f"{a_parse_dir}/batch{n}"
os.makedirs(batch_dir, exist_ok=True)

for resume_file in batch_resumes:
    shutil.copy(f"{resumes_dir}/{resume_file}", f"{batch_dir}/{resume_file}")

shutil.copy(f"{job_dir}/jd.md", f"{batch_dir}/jd.md")

cr_path = f"{job_dir}/skill-output/D-analysis/comprehensive-requirements.md"
if os.path.exists(cr_path):
    shutil.copy(cr_path, f"{batch_dir}/comprehensive-requirements.md")
```
