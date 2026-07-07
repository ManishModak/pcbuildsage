from __future__ import annotations

import json
from pathlib import Path

from scraper.normalizer import RegistryMatcher, normalize_title, parse_price_minor, product_id


def test_parse_price_minor_uses_integer_minor_units() -> None:
    assert parse_price_minor("₹1,23,456.78") == 12345678
    assert parse_price_minor("$499") == 49900
    assert parse_price_minor("No price") is None


def test_product_id_matches_shared_fixture() -> None:
    fixture = Path(__file__).resolve().parents[3] / "data" / "fixtures" / "sha1-urls.json"
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
    assert normalize_title("G.Skill Trident Z5 RGB 32GB DDR5") == "gskill trident z5"
    assert normalize_title("G-Skill Trident Z5 RGB 32GB DDR5") == "gskill trident z5"
    assert normalize_title("GSkill Trident Z5 RGB 32GB DDR5") == "gskill trident z5"
