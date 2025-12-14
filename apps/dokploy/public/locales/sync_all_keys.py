#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动补齐所有语言文件中缺失的键（以英文值占位）
从 en/common.json 和 en/settings.json 读取所有键，然后为其他语言文件补齐缺失的键
"""

import json
from pathlib import Path

# 语言代码到语言名称的映射
LANG_NAMES = {
    "az": "阿塞拜疆语",
    "de": "德语",
    "en": "英语",
    "es": "西班牙语",
    "fa": "波斯语",
    "fr": "法语",
    "id": "印尼语",
    "it": "意大利语",
    "ja": "日语",
    "ko": "韩语",
    "kz": "哈萨克语",
    "ml": "马拉雅拉姆语",
    "nl": "荷兰语",
    "no": "挪威语",
    "pl": "波兰语",
    "pt-br": "巴西葡萄牙语",
    "ru": "俄语",
    "tr": "土耳其语",
    "uk": "乌克兰语",
    "zh-Hans": "简体中文",
    "zh-Hant": "繁体中文",
}


def get_lang_name(lang_code: str) -> str:
    """获取语言名称"""
    return LANG_NAMES.get(lang_code, lang_code)


def load_json(path: Path) -> dict:
    """加载 JSON 文件"""
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: Path, data: dict) -> None:
    """保存 JSON 文件（保持原有格式）"""
    # 读取原始文件以保持缩进格式
    with path.open("r", encoding="utf-8") as f:
        original_content = f.read()
    
    # 检测缩进（tab 或空格）
    indent = "\t" if "\t" in original_content[:100] else "    "
    
    # 格式化并保存
    formatted = json.dumps(data, ensure_ascii=False, indent=4)
    # 如果原文件使用 tab，转换为 tab
    if indent == "\t":
        lines = formatted.split("\n")
        formatted = "\n".join(
            line.replace("    ", "\t", line.count("    ") // 4) if line.strip() else line
            for line in lines
        )
    
    with path.open("w", encoding="utf-8") as f:
        f.write(formatted + "\n")


def sync_file(base_dir: Path, filename: str) -> int:
    """同步指定文件类型（common.json 或 settings.json）"""
    # 读取英文文件作为参考
    en_path = base_dir / "en" / filename
    if not en_path.exists():
        print(f"⚠️  英文文件 {filename} 不存在，跳过")
        return 0
    
    en_data = load_json(en_path)
    print(f"\n{'=' * 70}")
    print(f"同步 {filename}（英文文件共有 {len(en_data)} 个键）")
    print("=" * 70)
    
    # 遍历所有语言目录
    total_added = 0
    for lang_dir in sorted(p for p in base_dir.iterdir() if p.is_dir()):
        lang_code = lang_dir.name
        
        # 跳过英文和隐藏目录
        if lang_code == "en" or lang_code.startswith("."):
            continue
        
        file_path = lang_dir / filename
        if not file_path.exists():
            lang_name = get_lang_name(lang_code)
            print(f"⚠️  {lang_name} ({lang_code}): {filename} 未找到，跳过")
            continue
        
        # 加载语言文件
        lang_data = load_json(file_path)
        
        # 找出缺失的键
        missing_keys = {k: en_data[k] for k in en_data if k not in lang_data}
        
        lang_name = get_lang_name(lang_code)
        if missing_keys:
            # 添加缺失的键
            lang_data.update(missing_keys)
            dump_json(file_path, lang_data)
            print(f"✓ {lang_name} ({lang_code}): 添加了 {len(missing_keys)} 个键")
            total_added += len(missing_keys)
        else:
            print(f"✓ {lang_name} ({lang_code}): 无需添加（键已完整）")
    
    return total_added


def main():
    """主函数：补齐所有缺失的键"""
    base_dir = Path(__file__).parent
    
    total_common = sync_file(base_dir, "common.json")
    total_settings = sync_file(base_dir, "settings.json")
    
    print("\n" + "=" * 70)
    print(f"完成！")
    print(f"  common.json: 总共添加了 {total_common} 个键")
    print(f"  settings.json: 总共添加了 {total_settings} 个键")
    print(f"  总计: {total_common + total_settings} 个键")


if __name__ == "__main__":
    main()

