from __future__ import annotations

import json
from pathlib import Path

from scraper.normalizer import (
    RegistryMatcher,
    classify_subcategory,
    normalize_title,
    parse_price,
    product_id,
    reclassify_category,
)


def test_parse_price_uses_major_units() -> None:
    assert parse_price("₹1,23,456.78") == 123456.78
    assert parse_price("$499") == 499.0
    assert parse_price("No price") is None


def test_product_id_matches_shared_fixture() -> None:
    fixture = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "sha1-urls.json"
    for entry in json.loads(fixture.read_text(encoding="utf-8")):
        digest = product_id(entry["url"])
        assert digest == entry["sha1"]
        assert len(digest) == 40
        assert digest == digest.lower()


def test_normalizer_strips_marketing_suffixes_and_matches_alias(tmp_path: Path) -> None:
    registry = tmp_path / "registry"
    registry.mkdir()
    (registry / "cpus.json").write_text(
        json.dumps(
            {
                "$schema": "../schemas/registry.schema.json",
                "amd-ryzen-7-9700x": {
                    "brand": "AMD",
                    "model": "Ryzen 7 9700X",
                    "aliases": ["ryzen 7 9700x", "r7 9700x"],
                },
            }
        ),
        encoding="utf-8",
    )
    normalized = normalize_title("AMD Ryzen 7 9700X Desktop Processor Boxed RGB Edition")
    assert normalized == "amd ryzen 7 9700x"
    assert RegistryMatcher(registry).match(normalized) == "amd-ryzen-7-9700x"


def test_normalizer_canonicalizes_gskill_brand_variants() -> None:
    assert normalize_title("G.Skill Trident Z5 RGB 32GB DDR5") == "gskill trident z5 32gb ddr5"
    assert normalize_title("G-Skill Trident Z5 RGB 32GB DDR5") == "gskill trident z5 32gb ddr5"
    assert normalize_title("GSkill Trident Z5 RGB 32GB DDR5") == "gskill trident z5 32gb ddr5"


def test_ram_capacity_and_ddr_generation_remain_identity_tokens() -> None:
    assert normalize_title("Crucial Pro 32GB DDR5") != normalize_title("Crucial Pro 16GB DDR4")
    assert normalize_title("Crucial Pro 32GB DDR5") == "crucial pro 32gb ddr5"
    assert normalize_title("Crucial Pro 16GB DDR4") == "crucial pro 16gb ddr4"


def test_registry_matcher_keeps_distinct_ram_aliases(tmp_path: Path) -> None:
    registry = tmp_path / "registry"
    registry.mkdir()
    (registry / "ram.json").write_text(
        json.dumps(
            {
                "$schema": "../schemas/registry.schema.json",
                "crucial-pro-32gb-ddr5": {
                    "brand": "Crucial",
                    "model": "Crucial Pro 32GB DDR5",
                    "aliases": ["Crucial Pro 32GB DDR5"],
                },
                "crucial-pro-16gb-ddr4": {
                    "brand": "Crucial",
                    "model": "Crucial Pro 16GB DDR4",
                    "aliases": ["Crucial Pro 16GB DDR4"],
                },
            }
        ),
        encoding="utf-8",
    )
    matcher = RegistryMatcher(registry)

    assert matcher.match(normalize_title("Crucial Pro 32GB DDR5 CL40 Kit")) == "crucial-pro-32gb-ddr5"
    assert matcher.match(normalize_title("Crucial Pro 16GB DDR4 CL22 Kit")) == "crucial-pro-16gb-ddr4"


def test_subcategory_classification_portable_ssd() -> None:
    # "Portable SSD" -> external
    assert classify_subcategory("Portable SSD", "storage") == "external"


def test_reclassify_category_gt_710_not_ram() -> None:
    # "GT 710 DDR5 Graphics Card" -> not RAM (storage -> storage)
    assert reclassify_category("GT 710 DDR5 Graphics Card", "storage") == "storage"

