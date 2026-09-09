#!/usr/bin/env python3
"""
Manage the resume processing worklist for Module A.

The worklist (A.worklist.md) is a lightweight, human-readable tracking table
that the agent updates after each resume is processed. It provides at-a-glance
status for large batches (100+ resumes) and drives sequential execution.

Usage:
    python worklist_manager.py <job_dir> --init          # Create worklist from resumes/
    python worklist_manager.py <job_dir> --next          # Print the next file to process
    python worklist_manager.py <job_dir> --complete <file> <quality_score> <credibility_score> [note]
    python worklist_manager.py <job_dir> --fail <file> <reason>
    python worklist_manager.py <job_dir> --skip <file> <reason>
    python worklist_manager.py <job_dir> --status        # Print summary stats
    python worklist_manager.py <job_dir> --table         # Print the full table

Examples:
    python worklist_manager.py /path/to/job --init
    python worklist_manager.py /path/to/job --next
    python worklist_manager.py /path/to/job --complete "张三.pdf" "82" "75" "985硕士"
    python worklist_manager.py /path/to/job --fail "李四.pdf" "图片PDF无法提取"
    python worklist_manager.py /path/to/job --skip "王五.pdf" "与#3确认重复"
"""

import sys
import os
import re
from pathlib import Path
from datetime import datetime


WORKLIST_FILENAME = "A.worklist.md"

SUPPORTED_EXT = {'.pdf', '.docx', '.doc', '.jpg', '.jpeg', '.png'}


def get_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def scan_resumes(resumes_dir: Path) -> list[str]:
    """Return sorted list of resume filenames."""
    files = []
    if not resumes_dir.exists():
        return files
    for f in sorted(resumes_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in SUPPORTED_EXT:
            files.append(f.name)
    return files


def init_worklist(job_dir: Path) -> str:
    """Create A.worklist.md from resumes/ directory."""
    resumes_dir = job_dir / "resumes"
    files = scan_resumes(resumes_dir)
    worklist_path = job_dir / "skill-output" / "A-parse" / WORKLIST_FILENAME

    lines = [
        "# Module A 简历处理进度表",
        "",
        f"- 总数：{len(files)}",
        f"- 已完成：0",
        f"- 失败：0",
        f"- 跳过：0",
        f"- 待处理：{len(files)}",
        f"- 最后更新：{get_timestamp()}",
        "",
        "## 状态说明",
        "- ⏳ 待处理 | ✅ 完成 | ❌ 失败 | ⏭️ 跳过",
        "",
        "## 进度表",
        "",
        "| # | 状态 | 文件名 | 质量分 | 可信度 | 备注 |",
        "|---|------|--------|--------|--------|------|",
    ]

    for i, fname in enumerate(files, 1):
        lines.append(f"| {i} | ⏳ | {fname} | — | — | — |")

    lines.append("")

    worklist_path.parent.mkdir(parents=True, exist_ok=True)
    worklist_path.write_text("\n".join(lines), encoding="utf-8")
    return str(worklist_path)


def parse_worklist(content: str) -> dict:
    """Parse worklist markdown into structured data."""
    result = {
        "header_lines": [],
        "table_header": [],
        "rows": [],
    }

    in_table = False
    for line in content.splitlines():
        if line.startswith("| # |") or line.startswith("|---|"):
            in_table = True
            result["table_header"].append(line)
            continue

        if in_table and line.startswith("|"):
            parts = [p.strip() for p in line.split("|")]
            # parts: ['', seq, status, filename, quality, credibility, note, '']
            if len(parts) >= 8:
                result["rows"].append({
                    "seq": parts[1],
                    "status": parts[2],
                    "filename": parts[3],
                    "quality": parts[4],
                    "credibility": parts[5],
                    "note": parts[6],
                    "raw": line,
                })
        elif not in_table:
            result["header_lines"].append(line)

    return result


def rebuild_worklist(parsed: dict) -> str:
    """Rebuild worklist markdown from parsed data."""
    # Update header stats
    total = len(parsed["rows"])
    done = sum(1 for r in parsed["rows"] if r["status"] == "✅")
    failed = sum(1 for r in parsed["rows"] if r["status"] == "❌")
    skipped = sum(1 for r in parsed["rows"] if r["status"] == "⏭️")
    pending = total - done - failed - skipped

    new_header = []
    for line in parsed["header_lines"]:
        if line.startswith("- 总数："):
            new_header.append(f"- 总数：{total}")
        elif line.startswith("- 已完成："):
            new_header.append(f"- 已完成：{done}")
        elif line.startswith("- 失败："):
            new_header.append(f"- 失败：{failed}")
        elif line.startswith("- 跳过："):
            new_header.append(f"- 跳过：{skipped}")
        elif line.startswith("- 待处理："):
            new_header.append(f"- 待处理：{pending}")
        elif line.startswith("- 最后更新："):
            new_header.append(f"- 最后更新：{get_timestamp()}")
        else:
            new_header.append(line)

    lines = new_header + parsed["table_header"]
    for r in parsed["rows"]:
        lines.append(f"| {r['seq']} | {r['status']} | {r['filename']} | {r['quality']} | {r['credibility']} | {r['note']} |")
    lines.append("")

    return "\n".join(lines)


def get_next_file(job_dir: Path) -> str | None:
    """Return the filename of the next pending resume, or None if all done."""
    worklist_path = job_dir / "skill-output" / "A-parse" / WORKLIST_FILENAME
    if not worklist_path.exists():
        return None
    content = worklist_path.read_text(encoding="utf-8")
    parsed = parse_worklist(content)
    for r in parsed["rows"]:
        if r["status"] == "⏳":
            return r["filename"]
    return None


def update_row(job_dir: Path, filename: str, status: str, quality: str = "—",
               credibility: str = "—", note: str = "—"):
    """Update a row in the worklist."""
    worklist_path = job_dir / "skill-output" / "A-parse" / WORKLIST_FILENAME
    content = worklist_path.read_text(encoding="utf-8")
    parsed = parse_worklist(content)

    updated = False
    for r in parsed["rows"]:
        if r["filename"] == filename:
            r["status"] = status
            r["quality"] = quality
            r["credibility"] = credibility
            r["note"] = note
            updated = True
            break

    if not updated:
        print(f"WARNING: File '{filename}' not found in worklist", file=sys.stderr)
        return

    new_content = rebuild_worklist(parsed)
    worklist_path.write_text(new_content, encoding="utf-8")


def get_status_summary(job_dir: Path) -> dict:
    """Return summary stats from worklist."""
    worklist_path = job_dir / "skill-output" / "A-parse" / WORKLIST_FILENAME
    if not worklist_path.exists():
        return {"error": "worklist not found"}
    content = worklist_path.read_text(encoding="utf-8")
    parsed = parse_worklist(content)

    total = len(parsed["rows"])
    done = sum(1 for r in parsed["rows"] if r["status"] == "✅")
    failed = sum(1 for r in parsed["rows"] if r["status"] == "❌")
    skipped = sum(1 for r in parsed["rows"] if r["status"] == "⏭️")
    pending = total - done - failed - skipped

    next_file = None
    for r in parsed["rows"]:
        if r["status"] == "⏳":
            next_file = r["filename"]
            break

    return {
        "total": total,
        "done": done,
        "failed": failed,
        "skipped": skipped,
        "pending": pending,
        "next": next_file,
        "progress_pct": round(done / total * 100, 1) if total > 0 else 0,
    }


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    job_dir = Path(sys.argv[1]).resolve()
    action = sys.argv[2]

    if action == "--init":
        path = init_worklist(job_dir)
        print(f"Worklist created at: {path}")

    elif action == "--next":
        next_file = get_next_file(job_dir)
        if next_file:
            print(next_file)
        else:
            print("ALL_DONE")

    elif action == "--complete":
        if len(sys.argv) < 6:
            print("Usage: --complete <filename> <quality_score> <credibility_score> [note]")
            sys.exit(1)
        filename = sys.argv[3]
        quality = sys.argv[4]
        credibility = sys.argv[5]
        note = sys.argv[6] if len(sys.argv) > 6 else "—"
        update_row(job_dir, filename, "✅", quality, credibility, note)
        print(f"✅ {filename} — quality:{quality} credibility:{credibility}")

    elif action == "--fail":
        if len(sys.argv) < 5:
            print("Usage: --fail <filename> <reason>")
            sys.exit(1)
        filename = sys.argv[3]
        reason = sys.argv[4]
        update_row(job_dir, filename, "❌", "—", "—", reason)
        print(f"❌ {filename} — {reason}")

    elif action == "--skip":
        if len(sys.argv) < 5:
            print("Usage: --skip <filename> <reason>")
            sys.exit(1)
        filename = sys.argv[3]
        reason = sys.argv[4]
        update_row(job_dir, filename, "⏭️", "—", "—", reason)
        print(f"⏭️ {filename} — {reason}")

    elif action == "--status":
        import json
        summary = get_status_summary(job_dir)
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    elif action == "--table":
        worklist_path = job_dir / "skill-output" / "A-parse" / WORKLIST_FILENAME
        if worklist_path.exists():
            print(worklist_path.read_text(encoding="utf-8"))
        else:
            print("Worklist not found. Run --init first.")

    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
