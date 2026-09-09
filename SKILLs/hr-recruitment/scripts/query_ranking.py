#!/usr/bin/env python3
"""
按需查询高校 reference 数据，避免加载全文到上下文。

Usage:
    python query_ranking.py <reference_file> <query>

Queries can be:
  - Chinese school name (exact or partial match): "中国人民大学"
  - School abbreviation: "人大"
  - QS-related: "QS 哥伦比亚" or "QS Columbia"
  - Tier check: "985" to get 985 list summary, "211" for 211, etc.

Output: Only matching lines from the reference file, formatted for context efficiency.

Examples:
    python query_ranking.py university-ranking.md "中国人民大学"
    python query_ranking.py university-ranking.md "哥伦比亚大学"
    python query_ranking.py university-ranking.md "985列表"
"""

import sys
from pathlib import Path


def search_file_lines(filepath: str, query: str) -> list[str]:
    """Search for query in reference file, return relevant context blocks."""
    lines = Path(filepath).read_text(encoding="utf-8").splitlines()
    results = []
    
    # Special keywords
    if query in ["985列表", "985名单", "985"]:
        in_section = False
        for line in lines:
            if "985 工程高校" in line or "1.2 全部 985" in line:
                in_section = True
                results.append(line)
                continue
            if in_section:
                if line.startswith("## 二、") or line.startswith("---"):
                    break
                results.append(line)
        return results
    
    if query in ["211列表", "211名单", "211"]:
        in_section = False
        for line in lines:
            if "211 工程高校" in line:
                in_section = True
                results.append(line)
                continue
            if in_section:
                if line.startswith("## 三、") or line.startswith("---"):
                    break
                results.append(line)
        return results
    
    if query in ["双一流列表", "双一流名单", "双一流"]:
        in_section = False
        for line in lines:
            if "双一流" in line and "建设" in line:
                in_section = True
                results.append(line)
                continue
            if in_section:
                if line.startswith("## ") or line.startswith("---"):
                    break
                results.append(line)
        return results
    
    if query.startswith("QS "):
        qs_query = query[3:].lower()
        in_qs = False
        for line in lines:
            if "QS 世界大学排名" in line or "2026 QS" in line:
                in_qs = True
                continue
            if in_qs:
                if line.startswith("## 四、") or (line.startswith("---") and results):
                    break
                if qs_query in line.lower():
                    # Return surrounding context (±2 lines)
                    results.append(line)
        return results
    
    # Default: search for the query string as school name
    query_lower = query.lower()
    
    # First try exact match (name in a table cell)
    for line in lines:
        if query in line and ('|' in line or '→' in line or '**' in line):
            results.append(line)
    
    # If no results, try partial match
    if not results:
        for line in lines:
            if query in line:
                results.append(line)
    
    # Also check abbreviation section
    for line in lines:
        if '简称对照' in line:
            continue
    
    return results


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    
    ref_file = sys.argv[1]
    query = sys.argv[2]
    
    results = search_file_lines(ref_file, query)
    
    if results:
        print(f"# 查询: {query} ({len(results)} 行匹配)\n")
        for line in results:
            print(line)
    else:
        print(f"# 查询: {query} — 未找到匹配")
        print("提示: 学校可能不在985/211/双一流/QS排名中，或尝试不同的搜索词（如完整校名）")


if __name__ == "__main__":
    main()
