#!/usr/bin/env python3
"""
Parallel processing coordinator for Module A.
Splits the worklist into N groups and outputs sub-session task prompts.
Usage: python parallel_split.py <job_dir> <num_groups>
"""
import sys, os

job_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
num_groups = int(sys.argv[2]) if len(sys.argv) > 2 else 5
worklist_path = os.path.join(job_dir, 'skill-output', 'A-parse', 'A.worklist.md')

if not os.path.exists(worklist_path):
    print(f'ERROR: worklist not found at {worklist_path}')
    sys.exit(1)

# Parse worklist to get pending files
lines = open(worklist_path, encoding='utf-8').read().splitlines()
pending = []
for line in lines:
    if '|' in line and line.strip().startswith('|'):
        parts = [p.strip() for p in line.split('|')]
        if len(parts) >= 3 and '⏳' in parts[2]:
            pending.append(parts[3])  # filename column

if not pending:
    print('No pending items in worklist!')
    sys.exit(0)

print(f'Total pending: {len(pending)}')
print(f'Groups: {num_groups}')
print()

group_size = max(1, (len(pending) + num_groups - 1) // num_groups)
groups = [pending[i:i + group_size] for i in range(0, len(pending), group_size)]

for gi, group in enumerate(groups):
    print(f'--- Group {gi+1}: {len(group)} resumes ---')
    for fn in group:
        print(f'  {fn}')
    print()

# Read JD for task prompt
jd_path = os.path.join(job_dir, 'jd.md')
jd_text = open(jd_path, encoding='utf-8').read() if os.path.exists(jd_path) else '(JD not found)'

# Read skill directory from worklist directory structure
skill_dir = os.environ.get('SKILL_DIR', '')

print('=' * 60)
print('SUB-SESSION TASK PROMPTS (copy one per sub-session)')
print('=' * 60)
print()

for gi, group in enumerate(groups):
    file_list = '\n'.join(f'  - {fn}' for fn in group)
    sp = gi * group_size + 1
    ep = sp + len(group) - 1
    print(f'''### Group {gi+1} ({sp}-{ep}, {len(group)} resumes) ###

sessions_spawn(
  task: \"\"\"你是 hr-recruitment-skill 的一个并行工作进程。

工作目录: {job_dir}
你的任务: 处理 A.worklist.md 中第 {sp} 到第 {ep} 行，共 {len(group)} 份简历。

你需要处理的文件列表:
{file_list}

JD (用于 A-S5 误分类检测):
{jd_text[:800]}

处理流程 (每份简历):
1. 读取 PDF 提取文本 (pypdf)
   - from pypdf import PdfReader → reader = PdfReader(path) → page.extract_text()
   - 如果提取长度 < 50 字符 → 使用视觉 fallback (pdf_to_png.py 脚本)
2. 写 {filename}.structured.md
   - 包含完整原文 + 结构化归一化 (个人信息/教育/工作/项目/其他)
   - 模板参考 SKILL.md 中 "structured.md Template" 部分
3. 做 A-S2→A-S5 分析 (信息提取、注水检测、质量评分、误分类)
4. 写 {filename}.analysis.md
5. 调用 track_complete.py 更新进度表

追踪命令:
python {skill_dir}/scripts/track_complete.py {job_dir} "FILENAME" "QUALITY" "CREDIBILITY" "NOTE"

完成后回复 "Group {gi+1}: {len(group)}/{len(group)} done"。
如果某份简历提取失败，标记为 ❌ 并继续下一份。\"\"\"
  runtime: "subagent"
  mode: "run"
)
''')
    print()

print(f'After spawning all {len(groups)} sub-sessions, call sessions_yield to wait for completion.')
