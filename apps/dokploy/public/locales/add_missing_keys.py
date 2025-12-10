#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为所有语言的 common.json 补齐新增加的键（以英文占位）。
不会覆盖已存在的值；英语原文件不修改。
"""

import json
from pathlib import Path


# 需要补齐的键列表（值从 en/common.json 读取）
TARGET_KEYS = [
    # Deploy settings
    "application.deploySettings.title",
    "application.deploySettings.tooltip.deploy",
    "application.deploySettings.tooltip.reload",
    "application.deploySettings.tooltip.rebuild",
    "application.deploySettings.tooltip.start",
    "application.deploySettings.tooltip.stop",
    "application.deploySettings.autoDeploy",
    "application.deploySettings.cleanCache",
    # Build server reminder
    "buildServer.alert.downloadReminder",
    # Traefik card
    "traefik.card.title",
    "traefik.card.description",
    "traefik.empty.description",
    # Server name defaults
    "server.defaultName",
    "ai.stepThree.defaultServerName",
    # Preview deployments (card/list/domain)
    "preview.card.title",
    "preview.card.description",
    "preview.intro",
    "preview.loading",
    "preview.empty",
    "preview.button.pullRequest",
    "preview.button.logs",
    "preview.button.deployments",
    "preview.disabled",
    "preview.domain.toast.updateSuccess",
    "preview.domain.toast.createSuccess",
    "preview.domain.toast.updateError",
    "preview.domain.toast.createError",
    "preview.domain.button.update",
    "preview.domain.button.create",
    "preview.domain.dialog.description.edit",
    "preview.domain.dialog.description.create",
    "preview.domain.dialog.title",
    "preview.domain.field.host",
    "preview.domain.field.hostPlaceholder",
    "preview.domain.tooltip.generateTraefikDomain",
    "preview.domain.field.path",
    "preview.domain.field.pathPlaceholder",
    "preview.domain.field.port",
    "preview.domain.field.portPlaceholder",
    "preview.domain.field.https",
    "preview.domain.field.httpsDescription",
    "preview.domain.certificate.label",
    "preview.domain.certificate.placeholder",
    "preview.domain.certificate.option.none",
    "preview.domain.certificate.option.letsencrypt",
    # Preview deployments (settings dialog)
    "preview.settings.button",
    "preview.settings.title",
    "preview.settings.description",
    "preview.settings.toast.saved",
    "preview.settings.wildcardDomain",
    "preview.settings.previewPath",
    "preview.settings.port",
    "preview.settings.previewLabels",
    "preview.settings.previewLabelsHelp",
    "preview.settings.previewLimit",
    "preview.settings.previewHttps",
    "preview.settings.previewHttpsDesc",
    "preview.settings.previewCertificateType",
    "preview.settings.previewCertificatePlaceholder",
    "preview.settings.cert.none",
    "preview.settings.cert.letsencrypt",
    "preview.settings.cert.custom",
    "preview.settings.previewCustomCertResolver",
    "preview.settings.enableTitle",
    "preview.settings.enableDesc",
    "preview.settings.requirePermissions",
    "preview.settings.requirePermissionsDesc",
    "preview.settings.env.title",
    "preview.settings.env.description",
    "preview.settings.env.placeholder",
    "preview.settings.buildArgs.title",
    "preview.settings.buildArgs.description",
    "preview.settings.buildArgs.linkLabel",
    "preview.settings.buildArgs.placeholder",
    "preview.settings.buildSecrets.title",
    "preview.settings.buildSecrets.description",
    "preview.settings.buildSecrets.linkLabel",
    "preview.settings.buildSecrets.placeholder",
    # Environment defaults
    "environment.default.production",
]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: Path, data: dict) -> None:
    formatted = json.dumps(data, ensure_ascii=False, indent=4)
    with path.open("w", encoding="utf-8") as f:
        f.write(formatted + "\n")


def main():
    base_dir = Path(__file__).parent
    en_path = base_dir / "en" / "common.json"
    if not en_path.exists():
        raise FileNotFoundError(f"Missing en/common.json at {en_path}")

    en_data = load_json(en_path)
    source = {k: en_data.get(k, "") for k in TARGET_KEYS}

    for lang_dir in sorted(p for p in base_dir.iterdir() if p.is_dir()):
        if lang_dir.name == "en":
            print(f"skip en")
            continue
        common_path = lang_dir / "common.json"
        if not common_path.exists():
            print(f"skip {lang_dir.name}: common.json not found")
            continue

        data = load_json(common_path)
        added = 0
        for key, value in source.items():
            if key not in data:
                data[key] = value
                added += 1

        if added > 0:
            dump_json(common_path, data)
            print(f"{lang_dir.name}: added {added} keys")
        else:
            print(f"{lang_dir.name}: no changes")


if __name__ == "__main__":
    main()

