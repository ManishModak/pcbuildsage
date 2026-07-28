from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .config import REPO_ROOT


MARKETING_PATTERNS = [
    r"\b(desktop\s+processor|processor|graphics\s+card|graphic\s+card|gaming|oc|edition|dual|triple|fan|rgb|gddr6x?)\b",
    r"\b(with\s+wraith\s+\w+|boxed|tray|bulk|retail)\b",
]

BRAND_CANONICAL = {
    "advanced micro devices": "amd",
    "g.skill": "gskill",
    "g-skill": "gskill",
    "gskill": "gskill",
    "micro-star international": "msi",
    "nvidia geforce": "nvidia",
}


# Retailers file products by shop-shelf taxonomy, not by build role: MDComputers'
# "storage" aisle holds internal SSDs alongside pen drives, memory cards, NAS
# units and the occasional RAM stick. `subcategory` records what a row actually
# is, so build flows can ask for parts that go *inside* a PC without anything
# being pruned from the catalog.
BUILD_SUBCATEGORY = "internal"

# DDR alone is not enough: "Asus GT 710 2GB DDR5 Graphics Card" is a GPU. Require
# a memory-module word or a CAS-latency token alongside it.
_DDR = re.compile(r"\bddr[345]\b", re.IGNORECASE)
_RAM_CONFIRM = re.compile(r"\b(ram|dimm|sodimm|udimm)\b|\bcl\d{2}\b", re.IGNORECASE)

_REMOVABLE = re.compile(
    r"pen\s*drive|pendrive|flash\s+drive|jump\s*drive|data\s*traveler|datatraveler"
    r"|micro\s*sdxc|micro\s*sdhc|micro\s*sd|sdxc|sdhc|memory\s+card|card\s+reader"
    r"|cruzer|\botg\b",
    re.IGNORECASE,
)
_EXTERNAL = re.compile(
    r"\bexternal\b|\bportable\b|my\s+passport|easystore|\benclosure\b|docking\s+station",
    re.IGNORECASE,
)
_INTERNAL = re.compile(
    r"\bnvme\b|\bm\.?2\b|\bsata\b|\bssd\b|\bhdd\b|hard\s+disk|hard\s+drive",
    re.IGNORECASE,
)
_ACCESSORY = re.compile(r"\bnas\b|rail\s*kit|\bcaddy\b|\bbracket\b", re.IGNORECASE)


def reclassify_category(name: str, category: str) -> str:
    """Correct a retailer's shelf category when the title says otherwise.

    Only RAM-in-storage is corrected today; that is the one misfiling observed in
    the live catalog, and it is what made the assistant tell a user "RAM is
    unavailable" while three DDR5 sticks sat in the storage aisle.
    """
    if category == "storage" and _DDR.search(name) and _RAM_CONFIRM.search(name):
        return "ram"
    return category


def classify_subcategory(name: str, category: str) -> str | None:
    """Return the build role of a product, or None when the category has no split.

    Order is load-bearing. External must precede internal, or a "Portable SSD"
    reads as an internal drive; internal must precede accessory, or a "4TB NAS
    HDD" (a real internal drive) reads as a NAS box. Storage titles that match
    nothing default to `internal`: hiding a genuine SSD from a build is a worse
    failure than admitting an unknown, and misclassification here is one UPDATE
    to undo, whereas exclusion is silent.
    """
    if category != "storage":
        return None
    if _REMOVABLE.search(name):
        return "removable"
    if _EXTERNAL.search(name):
        return "external"
    if _INTERNAL.search(name):
        return BUILD_SUBCATEGORY
    if _ACCESSORY.search(name):
        return "accessory"
    return BUILD_SUBCATEGORY


def product_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


def parse_price(price_text: str | None) -> float | None:
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
    return float(value)



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
