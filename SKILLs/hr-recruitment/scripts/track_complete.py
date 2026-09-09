#!/usr/bin/env python3
"""
Single-command resume completion tracker for Module A.

Combines worklist update + progress.md update (all 5 A-steps) + log append
into ONE call. Avoids the PowerShell && chaining problem and reduces tool calls.

Usage:
    python track_complete.py <job_dir> <filename> <quality> <credibility> <note>

Example:
    python track_complete.py D:/path/to/job "张三.pdf" "82" "75" "985硕士,2段实习"
"""

import sys
import re
from pathlib import Path
from datetime import datetime


def get_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


CS = get_timestamp()

WORKLIST_FILENAME = "A.worklist.md"
LOG_FILENAME = "A.log.md"

STEP_PATTERNS = {
    "A-S1": "A-S1 文本提取",
    "A-S2": "A-S2 信息抽取",
    "A-S3": "A-S3 注水检测",
    "A-S4": "A-S4 质量评分",
    "A-S5": "A-S5 误分类检测",
}


# ── Worklist Update ──────────────────────────────────────────────

def parse_worklist(content: str) -> dict:
    result = {"header_lines": [], "table_header": [], "rows": []}
    in_table = False
    for line in content.splitlines():
        if line.startswith("| # |") or line.startswith("|---|"):
            in_table = True
            result["table_header"].append(line)
            continue
        if in_table and line.startswith("|"):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 8:
                result["rows"].append({
                    "seq": parts[1], "status": parts[2], "filename": parts[3],
                    "quality": parts[4], "credibility": parts[5], "note": parts[6],
                })
        elif not in_table:
            result["header_lines"].append(line)
    return result


def rebuild_worklist(parsed: dict) -> str:
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
            new_header.append(f"- 最后更新：{CS}")
        else:
            new_header.append(line)

    lines = new_header + parsed["table_header"]
    for r in parsed["rows"]:
        lines.append(f"| {r['seq']} | {r['status']} | {r['filename']} | {r['quality']} | {r['credibility']} | {r['note']} |")
    lines.append("")
    return "\n".join(lines)


def update_worklist(job_dir: Path, filename: str, quality: str, credibility: str, note: str):
    wp = job_dir / "skill-output" / "A-parse" / WORKLIST_FILENAME
    content = wp.read_text(encoding="utf-8")
    parsed = parse_worklist(content)
    seq_num = None
    for r in parsed["rows"]:
        if r["filename"] == filename:
            r["status"] = "✅"
            r["quality"] = quality
            r["credibility"] = credibility
            r["note"] = note
            seq_num = r["seq"]
            break
    else:
        print(f"WARNING: '{filename}' not found in worklist", file=sys.stderr)
        return False, None
    wp.write_text(rebuild_worklist(parsed), encoding="utf-8")
    return True, seq_num


# ── progress.md Update ───────────────────────────────────────────

def update_progress(job_dir: Path, filename: str):
    pp = job_dir / "skill-output" / "progress.md"
    content = pp.read_text(encoding="utf-8")
    lines = content.splitlines()
    new_lines = []
    in_target = False
    updated_steps = set()

    for line in lines:
        m = re.match(r'^### #\d+ (.+)$', line)
        if m:
            in_target = (m.group(1) == filename)

        if in_target and not line.startswith("###"):
            for step_id, label in STEP_PATTERNS.items():
                if line.strip().startswith(f"- {label}："):
                    if step_id not in updated_steps:
                        line = f"- {label}：✅"
                        updated_steps.add(step_id)
                    break
            # Also update timestamp
            if line.startswith("- 最后更新："):
                line = f"- 最后更新：{CS}"

        new_lines.append(line)

    pp.write_text("\n".join(new_lines), encoding="utf-8")
    return len(updated_steps)


# ── Log Append ───────────────────────────────────────────────────

def append_log(job_dir: Path, filename: str, seq_num: str, quality: str, credibility: str, note: str):
    lp = job_dir / "skill-output" / "A-parse" / LOG_FILENAME
    seq_label = f"#{seq_num} " if seq_num else ""
    entry = (
        f"\n## [{CS}] {seq_label}{filename}\n"
        f"- A-S1~A-S5 ✅ | "
        f"quality:{quality} credibility:{credibility} | "
        f"note:{note}\n"
    )
    with open(lp, "a", encoding="utf-8") as f:
        f.write(entry)


# ── Main ─────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 6:
        print("Usage: python track_complete.py <job_dir> <filename> <quality> <credibility> <note>")
        sys.exit(1)

    job_dir = Path(sys.argv[1]).resolve()
    filename = sys.argv[2]
    quality = sys.argv[3]
    credibility = sys.argv[4]
    note = sys.argv[5]

    ok1, seq_num = update_worklist(job_dir, filename, quality, credibility, note)
    ok2 = update_progress(job_dir, filename)

    if ok1:
        append_log(job_dir, filename, seq_num, quality, credibility, note)

    print(f"✅ {filename}")
    print(f"   worklist: {'updated' if ok1 else 'FAILED'}")
    print(f"   progress.md: {ok2}/5 steps → ✅")


if __name__ == "__main__":
    main()
