from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .config import REPO_ROOT


MARKETING_PATTERNS = [
    r"\b(desktop\s+processor|processor|graphics\s+card|graphic\s+card|gaming|oc|edition|dual|triple|fan|rgb|gddr6x?|ddr[45])\b",
    r"\b(with\s+wraith\s+\w+|boxed|tray|bulk|retail)\b",
    r"\b\d+\s*gb\b",
]

BRAND_CANONICAL = {
    "advanced micro devices": "amd",
    "g.skill": "gskill",
    "g-skill": "gskill",
    "gskill": "gskill",
    "micro-star international": "msi",
    "nvidia geforce": "nvidia",
}


def product_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


def parse_price_minor(price_text: str | None) -> int | None:
    if not price_text:
        return None
    text = price_text.replace("\xa0", " ")
    match = re.search(r"(\d[\d,]*(?:\.\d{1,2})?)", text)
    if not match:
        return None
    numeric = match.group(1).replace(",", "")
    try:
        value = Decimal(numeric)
    except InvalidOperation:
        return None
    return int(value * 100)


def normalize_title(title: str) -> str:
    text = title.casefold()
    text = text.replace("&", " and ")
    text = re.sub(r"[\(\)\[\]\{\},|/]", " ", text)
    text = re.sub(r"[^a-z0-9+\-. ]+", " ", text)
    for source, target in BRAND_CANONICAL.items():
        text = re.sub(rf"\b{re.escape(source)}\b", target, text)
    for pattern in MARKETING_PATTERNS:
        text = re.sub(pattern, " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


class RegistryMatcher:
    def __init__(self, registry_dir: Path | None = None) -> None:
        self.registry_dir = registry_dir or (REPO_ROOT / "data" / "registry")
        self._aliases: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        if not self.registry_dir.exists():
            return
        for path in sorted(self.registry_dir.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            for key, entry in data.items():
                if key == "$schema" or not isinstance(entry, dict):
                    continue
                candidates = [key, str(entry.get("model", "")), *entry.get("aliases", [])]
                for alias in candidates:
                    normalized = normalize_title(str(alias))
                    if normalized:
                        self._aliases[normalized] = key

    def match(self, normalized_name: str) -> str | None:
        if normalized_name in self._aliases:
            return self._aliases[normalized_name]
        padded = f" {normalized_name} "
        matches = [
            (alias, key)
            for alias, key in self._aliases.items()
            if alias and f" {alias} " in padded
        ]
        if not matches:
            return None
        return max(matches, key=lambda item: len(item[0]))[1]
