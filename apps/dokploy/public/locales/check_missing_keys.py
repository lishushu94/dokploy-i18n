#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Compare zh-Hans vs zh-Hant common.json keys and print missing/extra.
"""

import json
from pathlib import Path


def main():
    base = Path(__file__).parent
    hans = json.load(open(base / "zh-Hans" / "common.json", encoding="utf-8"))
    hant = json.load(open(base / "zh-Hant" / "common.json", encoding="utf-8"))

    missing = [k for k in hans if k not in hant]
    extra = [k for k in hant if k not in hans]

    print(f"Missing in zh-Hant: {len(missing)}")
    for k in missing:
        print(k)

    print(f"\nExtra in zh-Hant: {len(extra)}")
    for k in extra:
        print(k)


if __name__ == "__main__":
    main()

