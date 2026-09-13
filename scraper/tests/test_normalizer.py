from __future__ import annotations

import json
from pathlib import Path

from scraper.__main__ import make_product
from scraper.models import BrowserConfig, RawProduct, SiteConfig
from scraper.normalizer import (
    RegistryMatcher,
    classify_subcategory,
    normalize_title,
    parse_cpu_package,
    parse_gpu_specs,
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


def test_parse_cpu_package_clues() -> None:
    assert parse_cpu_package("AMD Ryzen 5 5600 with Wraith Stealth Cooler") == {
        "cooler_included": "included",
        "cooler_name": "AMD Wraith Stealth",
    }
    assert parse_cpu_package("AMD Ryzen 7 3700X with Wraith Prism cooler") == {
        "cooler_included": "included",
        "cooler_name": "AMD Wraith Prism",
    }
    assert parse_cpu_package("Intel Core i5-12400 Boxed with cooler") == {
        "cooler_included": "included",
    }
    assert parse_cpu_package("AMD Ryzen 5 7600 Boxed (with fan)") == {
        "cooler_included": "included",
    }
    assert parse_cpu_package("Intel Core i5 12400 with stock cooler") == {
        "cooler_included": "included",
    }
    assert parse_cpu_package("AMD Ryzen 7 7800X3D Without Cooler") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("AMD Ryzen 7 7800X3D No Cooler") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("AMD Ryzen 7 7800X3D w/o cooler") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("AMD Ryzen 7 7800X3D Cooler Not Included") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("AMD Ryzen 7 7800X3D Tray") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("Intel Core i7-13700K OEM") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("AMD Ryzen 7 9700X 8GB") == {
        "cooler_included": "unknown",
    }
    # r4: explicit inclusion overrides generic oem/tray
    assert parse_cpu_package("AMD Ryzen 5 5600 OEM with Wraith Stealth") == {
        "cooler_included": "included",
        "cooler_name": "AMD Wraith Stealth",
    }
    assert parse_cpu_package("Intel Core i5-12400 Tray Boxed with cooler") == {
        "cooler_included": "included",
    }
    # r4: explicit no-cooler wording not overridden by cooler name
    assert parse_cpu_package("AMD Ryzen 5 5600 without cooler Wraith Stealth") == {
        "cooler_included": "not_included",
    }
    assert parse_cpu_package("AMD Ryzen 7 7800X3D No Cooler Wraith Prism") == {
        "cooler_included": "not_included",
    }
    # r4: conflicting statements stay unknown
    assert parse_cpu_package("AMD Ryzen 5 5600 with Wraith Stealth without cooler") == {
        "cooler_included": "unknown",
    }


def test_parse_gpu_specs_explicit_length_and_fans() -> None:
    # r4: explicit length contexts
    res1 = parse_gpu_specs("Gigabyte RTX 4070 Windforce OC Length: 261mm")
    assert res1 is not None and res1["length_mm"] == 261

    res2 = parse_gpu_specs("Sapphire Pure AMD Radeon RX 7700 XT 12GB Card Length: 320mm")
    assert res2 is not None and res2["length_mm"] == 320

    res3 = parse_gpu_specs("ASUS TUF Gaming GeForce RTX 4070 Ti Dimensions: 305 x 138 x 65 mm")
    assert res3 is not None and res3["length_mm"] == 305

    # r4: fan dimensions must NOT parse as card length
    assert parse_gpu_specs("MSI GeForce RTX 4060 Ventus 2X Black 8G OC Dual 100mm Fan") is None
    assert parse_gpu_specs("Gigabyte RTX 4070 Gaming OC 120mm PWM Fans") is None

    # r4: bare mm without explicit context is not accepted
    assert parse_gpu_specs("ZOTAC Gaming GeForce RTX 4060 8GB 222 mm") is None


def test_parse_cpu_package_laminar_token_boundaries() -> None:
    # Matches with boundary
    assert parse_cpu_package("Intel Core i5-12400 with Intel Laminar RM1") == {
        "cooler_included": "included",
        "cooler_name": "Intel Laminar RM1",
    }
    assert parse_cpu_package("Intel Core i5-12400 with Intel Laminar cooler") == {
        "cooler_included": "included",
        "cooler_name": "Intel Laminar RM1",
    }
    # Non-cooler phrases with bare "laminar" must not match cooler
    assert parse_cpu_package("Mid-tower case with laminar airflow guide") == {
        "cooler_included": "unknown",
    }


def test_make_product_gpu_specs_length(tmp_path: Path) -> None:
    raw = RawProduct(
        title="Sapphire Pure AMD Radeon RX 7700 XT 12GB Card Length: 320mm",
        price_text="$400",
        url="https://example.com/sapphire-7700xt",
        image_url=None,
        in_stock=True,
    )
    site = SiteConfig(
        site_name="Shop",
        base_url="https://example.com/",
        scraping_type="search",
        browser_config=BrowserConfig(),
        categories={},
        selectors={},
        country_code="US",
        currency="USD",
    )
    matcher = RegistryMatcher(tmp_path)
    product = make_product(raw, site, "gpu", matcher, "2026-09-13T00:00:00Z")
    assert product is not None
    assert product.specs.get("length_mm") == 320



