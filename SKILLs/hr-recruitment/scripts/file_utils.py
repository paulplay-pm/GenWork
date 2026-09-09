#!/usr/bin/env python3
"""
File utilities for hr-recruitment-skill.

Provides:
- File type detection
- Safe file copy (with duplicate check)
- Resume file listing
- Text extraction dispatch info

Runtime Dependency:
  This skill runs within the LobsterAI agent environment.
  PDF extraction uses `pypdf` (provided by LobsterAI's official pdf skill).
  DOCX extraction uses `python-docx` (provided by LobsterAI's official docx skill).
  If these are unavailable, install them before running Module A.
"""

import sys
import shutil
from pathlib import Path


# Supported file extensions and their extraction methods.
# 'pdf_skill' → LobsterAI official pdf skill (uses pypdf under the hood)
# 'docx_skill' → LobsterAI official docx skill (uses python-docx under the hood)
# 'vision' → LobsterAI model multimodal vision (direct image → text)
FILE_TYPE_MAP = {
    '.pdf': {'type': 'pdf', 'method': 'pdf_skill', 'fallback': 'vision'},
    '.docx': {'type': 'word', 'method': 'docx_skill', 'fallback': None},
    '.doc': {'type': 'word', 'method': 'docx_skill', 'fallback': None},
    '.jpg': {'type': 'image', 'method': 'vision', 'fallback': None},
    '.jpeg': {'type': 'image', 'method': 'vision', 'fallback': None},
    '.png': {'type': 'image', 'method': 'vision', 'fallback': None},
}


def detect_file_type(filepath: str) -> dict:
    """Detect file type and return extraction method info."""
    ext = Path(filepath).suffix.lower()
    info = FILE_TYPE_MAP.get(ext)
    if info:
        return {
            'filename': Path(filepath).name,
            'extension': ext,
            **info
        }
    return {
        'filename': Path(filepath).name,
        'extension': ext,
        'type': 'unknown',
        'method': 'unsupported',
        'fallback': None,
    }


def safe_copy(src: str, dst: str, overwrite: bool = False) -> dict:
    """Copy a file safely, checking for existing files."""
    src_path = Path(src)
    dst_path = Path(dst)

    if not src_path.exists():
        return {'success': False, 'error': f'Source not found: {src}'}

    if dst_path.exists() and not overwrite:
        return {
            'success': False,
            'error': f'Destination exists: {dst}',
            'skipped': True,
            'src_size': src_path.stat().st_size,
            'dst_size': dst_path.stat().st_size,
        }

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)

    return {
        'success': True,
        'src': str(src_path),
        'dst': str(dst_path),
        'size': dst_path.stat().st_size,
    }


def list_resumes(resumes_dir: str) -> list[dict]:
    """List all supported resume files in a directory."""
    path = Path(resumes_dir)
    if not path.exists():
        return []

    files = []
    for f in sorted(path.iterdir()):
        if f.is_file():
            info = detect_file_type(str(f))
            if info['type'] != 'unknown':
                info['size'] = f.stat().st_size
                info['path'] = str(f)
                files.append(info)

    return files


def main():
    """CLI interface for file utilities."""
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python file_utils.py detect <filepath>")
        print("  python file_utils.py list <resumes_dir>")
        print("  python file_utils.py copy <src> <dst> [--overwrite]")
        sys.exit(1)

    import json
    action = sys.argv[1]

    if action == "detect":
        result = detect_file_type(sys.argv[2])
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif action == "list":
        files = list_resumes(sys.argv[2])
        print(json.dumps(files, ensure_ascii=False, indent=2))

    elif action == "copy":
        if len(sys.argv) < 4:
            print("Usage: copy <src> <dst> [--overwrite]")
            sys.exit(1)
        overwrite = "--overwrite" in sys.argv
        result = safe_copy(sys.argv[2], sys.argv[3], overwrite)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    main()
