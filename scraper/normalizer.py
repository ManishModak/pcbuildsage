from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

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


# A card needs the "graphics card" phrase AND a GPU model number: Corsair's
# "Titan 360 RX LCD" is a CPU cooler, and an "RTX 4090 Water Block" is a cooling
# part. Anything naming a cooling part stays put.
_GRAPHICS_CARD = re.compile(r"\bgraphics?\s+card\b|\bvideo\s+card\b", re.IGNORECASE)
_GPU_MODEL = re.compile(r"\b(?:rtx|gtx|rx)\s*\d{3,4}\b|\barc\s*[abs]\d{3}\b", re.IGNORECASE)
_COOLING_PART = re.compile(
    r"cooler|cooling|water\s*block|\bbackplate\b|\bbracket\b|\bholder\b|\bsupport\b|\briser\b"
    r"|thermal",
    re.IGNORECASE,
)


def reclassify_category(name: str, category: str) -> str:
    """Correct a retailer's shelf category when the title says otherwise.

    Two misfilings observed in the live catalog are corrected:
    - RAM in storage: made the assistant tell a user "RAM is unavailable" while
      three DDR5 sticks sat in the storage aisle.
    - Graphics cards in cooler: MDComputers' cooler path redirected to its
      homepage, whose promo carousels (mostly GPUs) were saved as coolers and
      hidden from GPU searches.
    Rules are deliberately narrow; a missed correction is cheaper than moving a
    real part off its shelf.
    """
    if category == "storage" and _DDR.search(name) and _RAM_CONFIRM.search(name):
        return "ram"
    if (
        category == "cooler"
        and _GRAPHICS_CARD.search(name)
        and _GPU_MODEL.search(name)
        and not _COOLING_PART.search(name)
    ):
        return "gpu"
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


def strip_listing_context(url: str, listing_path: str) -> str:
    """Drop the listing a product link was found on, keeping the product page.

    MDComputers links name the listing and page: /product/<slug>/cabinet?page=3
    (older links: /product/cabinet/<slug>). Both serve rel=canonical
    /product/<slug>, but as raw ids the same product becomes a new row whenever
    it moves page. Removes the query, the fragment, and the path segment equal to
    the listing path's last segment, as long as two segments remain.
    """
    parts = urlsplit(url)
    listing_segment = listing_path.strip("/").rsplit("/", 1)[-1]
    segments = [s for s in parts.path.split("/") if s]
    if listing_segment in segments and len(segments) > 2:
        segments.remove(listing_segment)
    return urlunsplit((parts.scheme, parts.netloc, "/" + "/".join(segments), "", ""))


def product_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


def parse_price(price_text: str | None) -> float | None:
    """Return the listed price, not a number from marketing copy.

    With a currency token present, the first currency-anchored number wins:
    "Save 10% ₹45,000" -> 45000, and a discounted price listed before the
    struck-through original is kept. Without any currency token the first
    number wins: "45,000 (10% off)" -> 45000.
    """
    if not price_text:
        return None
    text = price_text.replace("\xa0", " ")
    # Currency-anchored numbers first: ₹45,000, Rs. 45000, 45000 INR, $499.
    currency_number = re.compile(
        r"(?:₹|\$|€|£|Rs\.?|INR|USD)\s*(\d[\d,]*(?:\.\d{1,2})?)"
        r"|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|Rs\.?|INR|USD)",
        re.IGNORECASE,
    )
    anchored = currency_number.search(text)
    if anchored:
        numeric = anchored.group(1) or anchored.group(2) or ""
    else:
        first = re.search(r"\d[\d,]*(?:\.\d{1,2})?", text)
        if not first:
            return None
        numeric = first.group(0)
    try:
        return float(Decimal(numeric.replace(",", "")))
    except InvalidOperation:
        return None


def parse_cpu_package(name: str) -> dict[str, str]:
    lower = name.lower()
    cooler_name = None
    if "wraith prism" in lower:
        cooler_name = "AMD Wraith Prism"
    elif "wraith stealth" in lower or re.search(r"\bwith\s+wraith\b", lower):
        cooler_name = "AMD Wraith Stealth"
    elif re.search(r"\bintel\s+laminar\b", lower) or re.search(r"\blaminar\s+rm1\b", lower):
        cooler_name = "Intel Laminar RM1"

    explicit_no_cooler_patterns = [
        r"\bwithout\s+cooler\b",
        r"\bno\s+cooler\b",
        r"\bw/o\s+cooler\b",
        r"\bcooler\s+not\s+included\b",
    ]
    generic_no_cooler_patterns = [
        r"\btray\b",
        r"\boem\b",
    ]
    explicit_included_patterns = [
        r"\bwith\s+wraith\b",
        r"\bwith\s+(?:stock\s+)?cooler\b",
        r"\bboxed\s+with\s+cooler\b",
        r"\bboxed\s*\(\s*with\s+fan\s*\)",
        r"\bwith\s+fan\b",
        r"\bwith\s+(?:(?:amd\s+)?wraith|intel\s+laminar|laminar\s+rm1)\b",
    ]

    has_explicit_no_cooler = any(re.search(p, lower) for p in explicit_no_cooler_patterns)
    has_generic_no_cooler = any(re.search(p, lower) for p in generic_no_cooler_patterns)
    has_explicit_included = any(re.search(p, lower) for p in explicit_included_patterns)

    # Conflicting statements stay unknown
    if has_explicit_no_cooler and has_explicit_included:
        return {"cooler_included": "unknown"}

    # Explicit no-cooler wording must NOT be overridden merely because a cooler name appears
    if has_explicit_no_cooler:
        return {"cooler_included": "not_included"}

    # Explicit inclusion keywords can override generic oem/tray labels
    if has_explicit_included:
        res: dict[str, str] = {"cooler_included": "included"}
        if cooler_name:
            res["cooler_name"] = cooler_name
        return res

    # Generic oem/tray labels without explicit inclusion
    if has_generic_no_cooler:
        return {"cooler_included": "not_included"}

    # If a known cooler name is present without negative clues, it's included
    if cooler_name is not None:
        return {"cooler_included": "included", "cooler_name": cooler_name}

    return {"cooler_included": "unknown"}


def parse_gpu_specs(name: str) -> dict[str, Any] | None:
    length_mm: int | None = None

    match = re.search(r"(?:card\s+)?length[:\s]+(\d{2,3}(?:\.\d+)?)\s*mm\b", name, re.I)
    if not match:
        match = re.search(r"(\d{2,3}(?:\.\d+)?)\s*mm\s+(?:card\s+)?length\b", name, re.I)

    if match:
        val = float(match.group(1))
        if 100 <= val <= 500:
            length_mm = round(val)
    else:
        dim_match = re.search(
            r"dimensions?[:\s]+(\d{2,3}(?:\.\d+)?)\s*(?:mm)?\s*(?:[x*×])\s*(\d{2,3}(?:\.\d+)?)\s*(?:mm)?\s*(?:[x*×])\s*(\d{2,3}(?:\.\d+)?)\s*mm\b",
            name,
            re.I,
        )
        if dim_match:
            dims = [float(dim_match.group(1)), float(dim_match.group(2)), float(dim_match.group(3))]
            max_dim = max(dims)
            if 100 <= max_dim <= 500:
                length_mm = round(max_dim)

    slot_width: float | None = None
    slot_match = re.search(r"(?<!m\.)(?<!pcie\s)(?<!pci-e\s)\b([1-4](?:\.[0-9])?)\s*[- ]?slots?\b", name, re.I)
    if slot_match:
        try:
            s_val = float(slot_match.group(1))
            if 1.0 <= s_val <= 5.0:
                slot_width = s_val
        except (ValueError, InvalidOperation):
            pass

    if length_mm is None and slot_width is None:
        return None

    brand = name.strip().split()[0] if name.strip() else ""
    res: dict[str, Any] = {
        "brand": brand,
        "model": name.strip(),
        "aliases": [name.strip()],
    }
    if length_mm is not None:
        res["length_mm"] = length_mm
    if slot_width is not None:
        res["slot_width"] = slot_width
    return res


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
