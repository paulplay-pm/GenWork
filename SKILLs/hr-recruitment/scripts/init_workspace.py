#!/usr/bin/env python3
"""
Initialize or recover the hr-recruitment-skill workspace.

Usage:
    python init_workspace.py <job_dir>

Actions:
  - If skill-output/ does not exist: create full directory structure, copy resumes, init progress.md
  - If skill-output/ exists: detect new resumes, run consistency checks, report recovery state
"""

import sys
import os
import shutil
from pathlib import Path
from datetime import datetime


def get_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def scan_resumes(resumes_dir: Path) -> list[dict]:
    """Scan resumes/ directory and return file info list."""
    supported_ext = {'.pdf', '.docx', '.doc', '.jpg', '.jpeg', '.png'}
    files = []
    if not resumes_dir.exists():
        return files
    for f in sorted(resumes_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in supported_ext:
            files.append({
                'name': f.name,
                'ext': f.suffix.lower(),
                'size': f.stat().st_size,
                'path': str(f),
            })
    return files


def init_progress(job_dir: Path, resume_files: list[dict]):
    """Create initial progress.md with all files at ⏳."""
    output_dir = job_dir / "skill-output"
    progress_path = output_dir / "progress.md"

    lines = [
        "# 全局进度\n",
        "## 岗位信息",
        f"- 岗位目录：{job_dir}",
        f"- JD来源：jd.md",
        f"- 简历总数：{len(resume_files)}",
        f"- 当前功能C版本：—",
        f"- 最后更新：{get_timestamp()}",
        "",
        "## 状态图例",
        "- ✅ 完成",
        "- 🔄 进行中",
        "- ⏳ 待处理",
        "- ⏭️ 跳过",
        "- ❌ 失败",
        "",
        "---",
        "",
    ]

    for i, f in enumerate(resume_files, 1):
        lines.extend([
            f"### #{i} {f['name']}",
            f"- 源文件：resumes/{f['name']}",
            f"- 副本：skill-output/A-parse/{f['name']}",
            f"- 去重状态：唯一",
            f"- A-S1 文本提取：⏳",
            f"- A-S2 信息抽取：⏳",
            f"- A-S3 注水检测：⏳",
            f"- A-S4 质量评分：⏳",
            f"- A-S5 误分类检测：⏳",
            f"- A 输出：A-parse/{f['name']}.analysis.md",
            f"- 备注：—",
            "",
            "---",
            "",
        ])

    progress_path.write_text("\n".join(lines), encoding="utf-8")
    return str(progress_path)


def fresh_start(job_dir: Path, resume_files: list[dict]):
    """Create full directory structure and initialize everything."""
    output_dir = job_dir / "skill-output"
    a_parse = output_dir / "A-parse"
    b_conditions = output_dir / "B-conditions"

    # Create directories
    for d in [output_dir, a_parse, b_conditions]:
        d.mkdir(parents=True, exist_ok=True)

    # Copy resume files to A-parse/
    copied = 0
    for f in resume_files:
        src = Path(f['path'])
        dst = a_parse / f['name']
        if not dst.exists():
            shutil.copy2(src, dst)
            copied += 1

    # Initialize progress.md
    progress_path = init_progress(job_dir, resume_files)

    # Create A.log.md
    log_path = a_parse / "A.log.md"
    ext_counts = {}
    for f in resume_files:
        ext = f['ext']
        ext_counts[ext] = ext_counts.get(ext, 0) + 1
    ext_summary = ", ".join(f"{ext.upper().lstrip('.')} {n}" for ext, n in sorted(ext_counts.items()))

    log_content = (
        f"# 功能A 处理日志\n\n"
        f"## [{get_timestamp()}] 启动\n"
        f"- 扫描 resumes/ 目录，发现 {len(resume_files)} 个文件\n"
        f"- 类型分布：{ext_summary}\n"
        f"- 复制到 A-parse/，{copied} 个新文件\n"
    )
    log_path.write_text(log_content, encoding="utf-8")

    return {
        "status": "fresh_start",
        "total_resumes": len(resume_files),
        "copied": copied,
        "progress_path": progress_path,
        "log_path": str(log_path),
    }


def check_recovery(job_dir: Path, resume_files: list[dict]):
    """Check existing workspace state and report recovery info."""
    output_dir = job_dir / "skill-output"
    a_parse = output_dir / "A-parse"
    progress_path = output_dir / "progress.md"

    result = {
        "status": "recovery",
        "progress_exists": progress_path.exists(),
        "new_files": [],
        "inconsistencies": [],
    }

    # Read existing progress to find known files
    known_files = set()
    if progress_path.exists():
        content = progress_path.read_text(encoding="utf-8")
        for line in content.splitlines():
            if line.startswith("- 源文件：resumes/"):
                fname = line.split("resumes/", 1)[1].strip()
                known_files.add(fname)

    # Detect new files
    for f in resume_files:
        if f['name'] not in known_files:
            result['new_files'].append(f['name'])
            # Copy new file to A-parse
            src = Path(f['path'])
            dst = a_parse / f['name']
            if not dst.exists():
                shutil.copy2(src, dst)

    # Check for analysis files without progress entries (orphans)
    if a_parse.exists():
        for af in a_parse.iterdir():
            if af.name.endswith('.analysis.md'):
                resume_name = af.name[:-len('.analysis.md')]
                if resume_name not in known_files:
                    result['inconsistencies'].append(
                        f"Orphan analysis file: {af.name} (no progress entry)"
                    )

    result['known_count'] = len(known_files)
    result['new_count'] = len(result['new_files'])
    return result


def main():
    if len(sys.argv) < 2:
        print("Usage: python init_workspace.py <job_dir>")
        sys.exit(1)

    job_dir = Path(sys.argv[1]).resolve()

    if not job_dir.exists():
        print(f"Error: Job directory does not exist: {job_dir}")
        sys.exit(1)

    resumes_dir = job_dir / "resumes"
    if not resumes_dir.exists():
        print(f"Error: resumes/ directory not found in {job_dir}")
        sys.exit(1)

    # Scan resumes
    resume_files = scan_resumes(resumes_dir)
    print(f"Found {len(resume_files)} resume files in resumes/")

    # Check JD
    jd_path = job_dir / "jd.md"
    if jd_path.exists():
        print(f"jd.md found ({jd_path.stat().st_size} bytes)")
    else:
        print("WARNING: jd.md not found — skill should ask HR for JD text")

    # Check feedback
    feedback_dir = job_dir / "feedback"
    if feedback_dir.exists() and any(feedback_dir.iterdir()):
        print(f"feedback/ directory found with content")
    else:
        print("feedback/ directory empty or not found (Module B unavailable)")

    # Fresh start or recovery?
    output_dir = job_dir / "skill-output"
    if not output_dir.exists():
        print("\n--- FRESH START ---")
        result = fresh_start(job_dir, resume_files)
        print(f"Created directory structure")
        print(f"Copied {result['copied']} resume files to A-parse/")
        print(f"Initialized progress.md at {result['progress_path']}")
        print(f"Created A.log.md at {result['log_path']}")
    else:
        print("\n--- RECOVERY MODE ---")
        result = check_recovery(job_dir, resume_files)
        print(f"Progress file exists: {result['progress_exists']}")
        print(f"Known files: {result['known_count']}")
        if result['new_files']:
            print(f"New files detected: {result['new_files']}")
        if result['inconsistencies']:
            print(f"Inconsistencies: {result['inconsistencies']}")
        print("\nAgent should now read progress.md and log.md to determine resume point.")

    import json
    print(f"\n--- RESULT JSON ---")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
