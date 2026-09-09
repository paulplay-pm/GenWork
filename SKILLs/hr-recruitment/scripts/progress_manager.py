#!/usr/bin/env python3
"""
Manage progress.md for the hr-recruitment-skill.

Usage:
    python progress_manager.py <job_dir> --status              # Show current progress summary
    python progress_manager.py <job_dir> --update <file> <step> <status> [detail]
    python progress_manager.py <job_dir> --add-files <file1> [file2 ...]  # Add new resume entries
    python progress_manager.py <job_dir> --consistency-check   # Run consistency check
    python progress_manager.py <job_dir> --set-c-version <n>   # Update current C version

Examples:
    python progress_manager.py /path/to/job --status
    python progress_manager.py /path/to/job --update "张三.pdf" "A-S1" "✅" "pdf解析"
    python progress_manager.py /path/to/job --update "张三.pdf" "A-S3" "✅" "可信度 72/100"
    python progress_manager.py /path/to/job --update "张三.pdf" "C-v1-S3" "✅" "通过"
    python progress_manager.py /path/to/job --add-files "新人.pdf" "新人2.docx"
    python progress_manager.py /path/to/job --consistency-check
"""

import sys
import os
import re
from pathlib import Path
from datetime import datetime


def get_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


STEP_PATTERNS = {
    "A-S1": "A-S1 文本提取",
    "A-S2": "A-S2 信息抽取",
    "A-S3": "A-S3 注水检测",
    "A-S4": "A-S4 质量评分",
    "A-S5": "A-S5 误分类检测",
}


def parse_progress(content: str) -> dict:
    """Parse progress.md into structured data."""
    result = {"header": [], "files": []}
    current_file = None
    header_done = False

    for line in content.splitlines():
        # Detect file entry
        m = re.match(r'^### #(\d+) (.+)$', line)
        if m:
            header_done = True
            if current_file:
                result["files"].append(current_file)
            current_file = {
                "seq": int(m.group(1)),
                "name": m.group(2),
                "lines": [line],
            }
            continue

        if current_file is not None:
            if line.startswith("---"):
                current_file["lines"].append(line)
                continue
            current_file["lines"].append(line)
        else:
            result["header"].append(line)

    if current_file:
        result["files"].append(current_file)

    return result


def update_step(content: str, filename: str, step: str, status: str, detail: str = "") -> str:
    """Update a specific step's status for a specific file in progress.md."""
    lines = content.splitlines()
    new_lines = []
    in_target_file = False
    updated = False

    # Handle both standard A-steps and C-version steps
    if step.startswith("C-v"):
        # e.g., "C-v1-S3" → "C-v1-S3 硬性过滤"
        step_labels = {
            "S3": "硬性过滤",
            "S4": "软性评分",
            "S5": "综合排序",
        }
        parts = step.split("-")  # ['C', 'v1', 'S3']
        version = parts[1]  # 'v1'
        sub_step = parts[2]  # 'S3'
        step_prefix = f"C-{version}-{sub_step} {step_labels.get(sub_step, '')}"
    else:
        step_prefix = STEP_PATTERNS.get(step, step)

    for line in lines:
        # Detect target file section
        m = re.match(r'^### #\d+ (.+)$', line)
        if m:
            in_target_file = (m.group(1) == filename)

        if in_target_file and step_prefix and line.strip().startswith(f"- {step_prefix}"):
            detail_str = f" {detail}" if detail else ""
            new_lines.append(f"- {step_prefix}：{status}{detail_str}")
            updated = True
            continue

        new_lines.append(line)

    # Update timestamp in header
    final_lines = []
    for line in new_lines:
        if line.startswith("- 最后更新："):
            final_lines.append(f"- 最后更新：{get_timestamp()}")
        else:
            final_lines.append(line)

    if not updated:
        print(f"WARNING: Could not find step '{step}' for file '{filename}'", file=sys.stderr)

    return "\n".join(final_lines)


def add_file_entries(content: str, new_files: list[str]) -> str:
    """Add new resume entries to progress.md."""
    parsed = parse_progress(content)
    max_seq = max((f["seq"] for f in parsed["files"]), default=0)

    # Update total count in header
    lines = content.splitlines()
    new_lines = []
    for line in lines:
        if line.startswith("- 简历总数："):
            old_count = int(re.search(r'\d+', line).group())
            new_lines.append(f"- 简历总数：{old_count + len(new_files)}")
        elif line.startswith("- 最后更新："):
            new_lines.append(f"- 最后更新：{get_timestamp()}")
        else:
            new_lines.append(line)

    # Append new file entries at the end
    for i, fname in enumerate(new_files, max_seq + 1):
        new_lines.extend([
            "",
            f"### #{i} {fname}",
            f"- 源文件：resumes/{fname}",
            f"- 副本：skill-output/A-parse/{fname}",
            f"- 去重状态：唯一",
            f"- A-S1 文本提取：⏳",
            f"- A-S2 信息抽取：⏳",
            f"- A-S3 注水检测：⏳",
            f"- A-S4 质量评分：⏳",
            f"- A-S5 误分类检测：⏳",
            f"- A 输出：A-parse/{fname}.analysis.md",
            f"- 备注：新增文件",
            "",
            "---",
        ])

    return "\n".join(new_lines)


def get_status_summary(content: str) -> dict:
    """Parse progress.md and return a status summary."""
    parsed = parse_progress(content)
    summary = {
        "total_files": len(parsed["files"]),
        "a_complete": 0,
        "a_in_progress": 0,
        "a_pending": 0,
        "a_failed": 0,
        "a_skipped": 0,
        "next_file": None,
        "next_step": None,
    }

    for f in parsed["files"]:
        file_text = "\n".join(f["lines"])
        # Check if all A-steps are complete
        a_steps_done = all(
            f"- {label}：✅" in file_text or f"- {label}：⏭️" in file_text or f"- {label}：❌" in file_text
            for label in STEP_PATTERNS.values()
        )
        if a_steps_done:
            summary["a_complete"] += 1
        elif any(f"- {label}：🔄" in file_text for label in STEP_PATTERNS.values()):
            summary["a_in_progress"] += 1
            if summary["next_file"] is None:
                summary["next_file"] = f["name"]
                for step_id, label in STEP_PATTERNS.items():
                    if f"- {label}：🔄" in file_text:
                        summary["next_step"] = step_id
                        break
        elif any(f"- {label}：❌" in file_text for label in STEP_PATTERNS.values()):
            summary["a_failed"] += 1
        elif any(f"- {label}：⏭️" in file_text for label in STEP_PATTERNS.values()):
            # Check if skipped (e.g., duplicate)
            if "去重状态：⏭️" in file_text:
                summary["a_skipped"] += 1
            else:
                summary["a_pending"] += 1
        else:
            summary["a_pending"] += 1
            if summary["next_file"] is None:
                summary["next_file"] = f["name"]
                for step_id, label in STEP_PATTERNS.items():
                    if f"- {label}：⏳" in file_text:
                        summary["next_step"] = step_id
                        break

    return summary


def consistency_check(job_dir: Path) -> list[dict]:
    """Run consistency check between progress.md and actual files."""
    output_dir = job_dir / "skill-output"
    a_parse = output_dir / "A-parse"
    progress_path = output_dir / "progress.md"

    issues = []

    if not progress_path.exists():
        return [{"type": "error", "msg": "progress.md not found"}]

    content = progress_path.read_text(encoding="utf-8")
    parsed = parse_progress(content)

    for f in parsed["files"]:
        fname = f["name"]
        file_text = "\n".join(f["lines"])
        analysis_path = a_parse / f"{fname}.analysis.md"

        # Check: ✅ on all A-steps but no analysis file
        all_a_done = all(
            f"- {label}：✅" in file_text
            for label in STEP_PATTERNS.values()
        )
        if all_a_done and not analysis_path.exists():
            issues.append({
                "type": "missing_output",
                "file": fname,
                "msg": f"All A-steps marked ✅ but {fname}.analysis.md not found",
                "action": "Reset all A-steps to ⏳ and reprocess"
            })

        # Check: 🔄 status (interrupted)
        for step_id, label in STEP_PATTERNS.items():
            if f"- {label}：🔄" in file_text:
                issues.append({
                    "type": "interrupted",
                    "file": fname,
                    "step": step_id,
                    "msg": f"{fname} step {step_id} was interrupted (🔄)",
                    "action": "Reset to ⏳ and reprocess"
                })

        # Check: analysis file exists but status not ✅
        if analysis_path.exists() and not all_a_done:
            issues.append({
                "type": "orphan_output",
                "file": fname,
                "msg": f"{fname}.analysis.md exists but A-steps not all ✅",
                "action": "Delete analysis file and reprocess incomplete steps"
            })

    return issues


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    job_dir = Path(sys.argv[1]).resolve()
    action = sys.argv[2]
    progress_path = job_dir / "skill-output" / "progress.md"

    if action == "--status":
        if not progress_path.exists():
            print("No progress.md found. Workspace not initialized.")
            sys.exit(1)
        content = progress_path.read_text(encoding="utf-8")
        import json
        summary = get_status_summary(content)
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    elif action == "--update":
        if len(sys.argv) < 6:
            print("Usage: --update <filename> <step> <status> [detail]")
            sys.exit(1)
        filename = sys.argv[3]
        step = sys.argv[4]
        status = sys.argv[5]
        detail = sys.argv[6] if len(sys.argv) > 6 else ""

        content = progress_path.read_text(encoding="utf-8")
        updated = update_step(content, filename, step, status, detail)
        progress_path.write_text(updated, encoding="utf-8")
        print(f"Updated {filename} {step} → {status}")

    elif action == "--add-files":
        new_files = sys.argv[3:]
        if not new_files:
            print("No files specified")
            sys.exit(1)
        content = progress_path.read_text(encoding="utf-8")
        updated = add_file_entries(content, new_files)
        progress_path.write_text(updated, encoding="utf-8")
        print(f"Added {len(new_files)} new file entries")

    elif action == "--consistency-check":
        import json
        issues = consistency_check(job_dir)
        if issues:
            print(f"Found {len(issues)} issues:")
            print(json.dumps(issues, ensure_ascii=False, indent=2))
        else:
            print("No consistency issues found.")

    elif action == "--set-c-version":
        if len(sys.argv) < 4:
            print("Usage: --set-c-version <n>")
            sys.exit(1)
        version = sys.argv[3]
        content = progress_path.read_text(encoding="utf-8")
        content = re.sub(
            r'- 当前功能C版本：.*',
            f'- 当前功能C版本：v{version}',
            content
        )
        progress_path.write_text(content, encoding="utf-8")
        print(f"Set C version to v{version}")

    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
