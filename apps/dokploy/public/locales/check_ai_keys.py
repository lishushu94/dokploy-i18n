#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检查所有语言文件的 AI 相关键
"""
import json
from pathlib import Path

# 读取英文文件作为参考
with open('en/common.json', 'r', encoding='utf-8') as f:
    en_data = json.load(f)

# 获取所有 AI 相关键
ai_keys = {k for k in en_data.keys() if k.startswith('ai.')}
print(f"英文文件中的 AI 键数: {len(ai_keys)}\n")

# 检查每个语言文件
script_dir = Path(__file__).parent
lang_dirs = sorted([d for d in script_dir.iterdir() if d.is_dir() and not d.name.startswith('.')])

print("=" * 70)
print("AI 键缺失情况:")
print("=" * 70)

for lang_dir in lang_dirs:
    file_path = lang_dir / 'common.json'
    if file_path.exists():
        with open(file_path, 'r', encoding='utf-8') as f:
            lang_data = json.load(f)
        
        lang_keys = set(lang_data.keys())
        missing_ai_keys = ai_keys - lang_keys
        
        if missing_ai_keys:
            print(f"\n{lang_dir.name}: 缺少 {len(missing_ai_keys)} 个 AI 键")
            if len(missing_ai_keys) <= 10:
                for key in sorted(missing_ai_keys):
                    print(f"  - {key}")
            else:
                for key in sorted(list(missing_ai_keys)[:10]):
                    print(f"  - {key}")
                print(f"  ... 还有 {len(missing_ai_keys) - 10} 个")
        else:
            print(f"✓ {lang_dir.name}: 所有 AI 键完整")

