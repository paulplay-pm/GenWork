#!/usr/bin/env python3
"""
Log utilities for hr-recruitment-skill.

Usage:
    python log_utils.py <log_file_path> <message>
    python log_utils.py <log_file_path> --section <header> <message>

Appends a timestamped entry to the specified log file.

Examples:
    python log_utils.py /path/to/A.log.md "Processing 张三.pdf A-S1..."
    python log_utils.py /path/to/A.log.md --section "#1 张三.pdf" "A-S1 文本提取：pdf skill，成功，3页"
"""

import sys
from pathlib import Path
from datetime import datetime


def get_timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def append_log(log_path: Path, message: str, section_header: str = None):
    """Append a timestamped entry to a log file."""
    timestamp = get_timestamp()

    if section_header:
        entry = f"\n## [{timestamp}] {section_header}\n{message}\n"
    else:
        entry = f"\n## [{timestamp}]\n{message}\n"

    # Create file with header if it doesn't exist
    if not log_path.exists():
        module = "A" if "A.log" in log_path.name else "B" if "B.log" in log_path.name else "C"
        log_path.write_text(f"# 功能{module} 处理日志\n{entry}", encoding="utf-8")
    else:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    log_path = Path(sys.argv[1])

    if sys.argv[2] == "--section":
        if len(sys.argv) < 5:
            print("Usage: --section <header> <message>")
            sys.exit(1)
        section_header = sys.argv[3]
        message = sys.argv[4]
        append_log(log_path, message, section_header)
    else:
        message = sys.argv[2]
        append_log(log_path, message)

    print(f"Appended to {log_path}")


if __name__ == "__main__":
    main()
