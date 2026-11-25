from __future__ import annotations

import json
from pathlib import Path

from scraper.__main__ import make_product
from scraper.config import load_profile
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
    strip_listing_context,
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


def test_non_build_items_on_other_shelves_are_accessories() -> None:
    # Titles from Vishal Peripherals' cooler, PSU and RAM collections.
    assert classify_subcategory("DEEPCOOL FT12 120MM PWM CABINET FAN (TRIPLE PACK)", "cooler") == "accessory"
    assert classify_subcategory("THERMALTAKE TOUGHFAN 12 RGB | RADIATOR FAN | 3 PACK", "cooler") == "accessory"
    assert classify_subcategory("LIAN LI UNI FAN SL WIRELESS 3 X 120MM KIT CASE FAN I COOLER - WHITE", "cooler") == "accessory"
    assert classify_subcategory("ZEBRONICS 735VA UPS", "psu") == "accessory"
    assert classify_subcategory("Kingpin KPx 1.5g Thermal Grease", "cooler") == "accessory"
    assert classify_subcategory("Deepcool GamerStorm G40 CPU Cooling Thermal Paste DP-GS-TP-G40", "cooler") == "accessory"
    assert classify_subcategory("CRUCIAL BASICS 16GB DDR5-4800 SODIMM LAPTOP RAM CB16GS4800", "ram") == "accessory"
    assert classify_subcategory("EVM 16GB 3200MHz CL19 DDR4 Laptop RAM", "ram") == "accessory"


def test_build_parts_on_those_shelves_stay_untagged() -> None:
    assert classify_subcategory("Cooler Master Hyper 212 Spectrum V3 ARGB CPU Cooler - 120mm Fan", "cooler") is None
    assert classify_subcategory("Gamdias CHIONE P2-360R AIO Liquid Cooler with Triple 120mm RGB Silent Fan", "cooler") is None
    # CPU coolers whose retailer titles only say "fan".
    assert classify_subcategory("ANT ESPORTS ICE-C200 V2 LED FAN", "cooler") is None
    assert classify_subcategory("DEEPCOOL LE360 V2 ARGB WHITE FAN ( R-LE360-WHAMMN-G-2)", "cooler") is None
    assert classify_subcategory("Deepcool AK620 G2 120mm Cabinet FAN R-AK620G2-BKNNMN-GJD", "cooler") is None
    assert classify_subcategory("Corsair RM850e 850W 80 Plus Gold Fully Modular PSU", "psu") is None
    assert classify_subcategory("Kingston Fury Beast 16GB DDR5 5200MHz Desktop RAM", "ram") is None
    assert classify_subcategory("G.Skill Ripjaws 16GB DDR4 Desktop RAM, not for laptop", "ram") is None


def test_reclassify_category_gt_710_not_ram() -> None:
    # "GT 710 DDR5 Graphics Card" -> not RAM (storage -> storage)
    assert reclassify_category("GT 710 DDR5 Graphics Card", "storage") == "storage"


def test_reclassify_category_gpu_on_cooler_shelf() -> None:
    assert reclassify_category("Gigabyte RTX 5050 Windforce OC 8GB GDDR6 Graphics Card", "cooler") == "gpu"
    assert reclassify_category("ASUS Prime RX 9060 XT OC Edition 16GB GDDR6 Graphics Card", "cooler") == "gpu"


def test_reclassify_category_real_coolers_stay() -> None:
    # "RX" in a cooler's product line is not a Radeon model.
    assert reclassify_category("Corsair iCUE LINK Titan 360 RX LCD White CPU Cooler", "cooler") == "cooler"
    assert reclassify_category("EK Quantum Vector RTX 4090 Water Block for Graphics Card", "cooler") == "cooler"


def test_swafan_packs_on_cooler_shelf_are_accessories() -> None:
    # Case 1: Thermaltake SWAFAN packs on cooler shelves -> accessory; real coolers stay untagged.
    assert classify_subcategory("Thermaltake SWAFAN EX12 ARGB Sync White (3-Pack)", "cooler") == "accessory"
    assert classify_subcategory("Thermaltake SWAFAN EX14 ARGB Sync PC Cooling Fan (3-Fan Pack)", "cooler") == "accessory"
    assert classify_subcategory("Thermaltake SWAFAN 12 RGB Radiator Fan Pack", "cooler") == "accessory"
    assert classify_subcategory("Thermaltake Toughair 510 CPU Cooler", "cooler") is None
    assert classify_subcategory("Thermaltake TH360 V2 ARGB Sync AIO Liquid Cooler", "cooler") is None
    assert classify_subcategory("Thermaltake TH360 V2 ARGB AIO Liquid Cooler with SWAFAN", "cooler") is None


def test_aio_coolers_on_case_shelf_reclassify_while_real_cases_stay() -> None:
    # Case 2: Antec / similar AIOs in case -> cooler, and their subcategory stays build-eligible (None).
    for title in (
        "Antec Symphony 360 ARGB AIO Liquid Cooler",
        "Antec Vortex 240 ARGB All-in-One Liquid CPU Cooler",
        "Antec Vortex Lum 360 ARGB AIO",
        "Deepcool LE520 240mm AIO Liquid Cooler",
        "Antec Vortex 360 ARGB 360mm Liquid Cooling with 3 x 120mm PWM Fans",
        "NZXT Kraken 240 240mm All-in-One Cooler with F120P Fans",
    ):
        assert reclassify_category(title, "case") == "cooler"
        assert classify_subcategory(title, "cooler") is None

    # Standalone fans advertised *for* liquid cooling remain accessories.
    assert classify_subcategory("Noctua NF-F12 120mm PWM Fan for Liquid Cooling Radiators", "cooler") == "accessory"

    # Negative: PC cases mentioning AIO radiator support must remain cases.
    assert reclassify_category("Antec CX700 RGB Elite ATX Mid Tower Cabinet - Supports 360mm AIO Liquid Cooler", "case") == "case"
    assert reclassify_category("Lian Li O11 Vision Compact Supports 360mm AIO Liquid Cooler", "case") == "case"
    assert reclassify_category("Lian Li O11 Vision Compact compatible with 360mm AIO", "case") == "case"
    assert reclassify_category("Deepcool CG580 4F Mid-Tower Cabinet (360mm AIO Support)", "case") == "case"
    assert reclassify_category("NZXT H7 Flow Mid Tower Case - Support 240mm / 360mm Radiator", "case") == "case"


def test_jetson_dev_kits_on_gpu_shelf_are_accessories() -> None:
    # Case 3: NVIDIA Jetson dev kits under gpu -> accessory; real GPUs stay untagged.
    assert classify_subcategory("NVIDIA Jetson Orin Nano Super Developer Kit", "gpu") == "accessory"
    assert classify_subcategory("NVIDIA Jetson Nano 4GB Dev Kit", "gpu") == "accessory"
    assert classify_subcategory("NVIDIA GeForce RTX 4070 Super 12GB Graphics Card", "gpu") is None
    assert classify_subcategory("Gigabyte RTX 5070 Ti Windforce OC 16GB", "gpu") is None


def test_qnap_and_storage_adapters_are_accessories() -> None:
    # Case 4: QNAP adapters / expansion cards under storage -> accessory; real internal drives stay internal.
    assert classify_subcategory("QNAP QM2-2P-384A Dual M.2 PCIe NVMe SSD Expansion Card", "storage") == "accessory"
    assert classify_subcategory("QNAP QXG-10G1T 10GbE PCIe Network Adapter", "storage") == "accessory"
    assert classify_subcategory("QNAP QDA-A2AR Dual 2.5-inch SATA Drive Adapter", "storage") == "accessory"
    assert classify_subcategory("Orico M.2 NVMe to PCIe 3.0 x4 Adapter Card", "storage") == "accessory"
    assert classify_subcategory('U.2 (SFF-8643) to M.2 PCI Express 4.0 x4 Host Adapter Card for 2.5" U.2 NVMe SSD', "storage") == "accessory"
    assert classify_subcategory("StarTech 3-Port M.2 SSD (NGFF) Adapter Card", "storage") == "accessory"
    assert classify_subcategory("Intel Optane 900P Series 2.5 SSD including M.2 Adapter - 280 GB", "storage") == "internal"
    assert classify_subcategory("Samsung 990 PRO 2TB M.2 NVMe Gen4 Internal SSD", "storage") == "internal"
    assert classify_subcategory("Crucial MX500 1TB 2.5-inch SATA SSD", "storage") == "internal"
    assert classify_subcategory("Seagate IronWolf 4TB NAS Internal HDD", "storage") == "internal"


def test_usb_flash_and_thumb_drives_without_portable_are_removable() -> None:
    # Case 5: USB flash/thumb drives without "portable" -> removable; portable SSDs stay external, NVMe/SATA stay internal.
    assert classify_subcategory("SanDisk Ultra Flair 64GB USB 3.2", "storage") == "removable"
    assert classify_subcategory("SanDisk Ultra Flair 64GB USB-A 3.2", "storage") == "removable"
    assert classify_subcategory("Samsung BAR Plus 128GB USB Type-A", "storage") == "removable"
    assert classify_subcategory("Kingston DataTraveler 64GB USB Drive", "storage") == "removable"
    assert classify_subcategory("Verbatim 128GB USB Drive", "storage") == "removable"
    assert classify_subcategory("SanDisk 64GB Thumb Drive", "storage") == "removable"
    assert classify_subcategory("Samsung BAR Plus 128GB USB-C", "storage") == "removable"
    assert classify_subcategory("Samsung T7 1TB Portable SSD USB 3.2 Gen 2", "storage") == "external"
    assert classify_subcategory("WD My Passport 2TB External HDD USB 3.0", "storage") == "external"
    assert classify_subcategory("WD Black SN850X 1TB M.2 NVMe SSD", "storage") == "internal"
    assert classify_subcategory("Kingston A400 480GB 2.5 SATA SSD", "storage") == "internal"


def test_ddr_ram_kits_on_motherboard_shelf_reclassify_while_boards_stay() -> None:
    # Case 6: AORUS memory kits and DDR RAM kits under motherboards -> ram.
    assert reclassify_category("Gigabyte AORUS RGB Memory 16GB (2x8GB) 3733MHz DDR4", "motherboard") == "ram"
    assert reclassify_category("Gigabyte AORUS RGB Memory 16GB (2x8GB) 3733MHz DDR4 for AM4", "motherboard") == "ram"
    assert reclassify_category("Gigabyte AORUS RGB Memory 16GB (2x8GB) 3333MHz", "motherboard") == "ram"
    assert reclassify_category("Gigabyte AORUS Memory 32GB (2x16GB) DDR5 6000MT/s", "motherboard") == "ram"
    assert reclassify_category("Corsair Vengeance 32GB (2x16GB) DDR5 6000MHz CL30", "motherboard") == "ram"
    assert reclassify_category("Kingston Fury Beast 16GB DDR5 5200MHz", "motherboard") == "ram"
    assert reclassify_category("G.Skill Ripjaws V 16GB DDR4 Desktop RAM", "motherboard") == "ram"

    # Negative: real motherboards mentioning DDR4/DDR5 or memory slots must stay motherboard.
    assert reclassify_category("Gigabyte B650 AORUS Elite DDR5 Motherboard", "motherboard") == "motherboard"
    assert reclassify_category("Gigabyte B650 AORUS Elite AX DDR5", "motherboard") == "motherboard"
    assert reclassify_category("MSI B840M GAMING PLUS WIFI6E, 4x DDR5 UDIMM, Maximum Memory Capacity 256GB", "motherboard") == "motherboard"
    assert reclassify_category("MSI PRO B760M-A WIFI DDR4", "motherboard") == "motherboard"
    assert reclassify_category("ASUS PRIME H610M-E DDR4 Motherboard", "motherboard") == "motherboard"
    assert reclassify_category("ASUS ROG Strix Z790-E Gaming WiFi DDR5", "motherboard") == "motherboard"


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





def test_strip_listing_context_handles_both_mdcomputers_link_shapes() -> None:
    canonical = "https://mdcomputers.in/product/asus-dual-rtx5060ti-16g"
    # Current links put the listing after the slug; older ones before it.
    assert strip_listing_context(f"{canonical}/graphics-card?page=3", "catalog/graphics-card") == canonical
    assert strip_listing_context(f"{canonical}/graphics-card", "catalog/graphics-card") == canonical
    assert (
        strip_listing_context("https://mdcomputers.in/product/cabinet/nzxt-h5", "catalog/cabinet")
        == "https://mdcomputers.in/product/nzxt-h5"
    )


def test_strip_listing_context_keeps_slug_that_matches_listing() -> None:
    # Only the query goes when removing the segment would leave /product alone.
    assert (
        strip_listing_context("https://mdcomputers.in/product/storage?page=2", "catalog/storage")
        == "https://mdcomputers.in/product/storage"
    )


def test_make_product_gives_one_id_per_mdcomputers_product(tmp_path: Path) -> None:
    site = next(s for s in load_profile("india").sites if s.site_name == "MDComputers")
    matcher = RegistryMatcher(tmp_path)

    def row(url: str):
        raw = RawProduct(title="NZXT H5 Flow", price_text="₹8,500", url=url, image_url=None, in_stock=True)
        return make_product(raw, site, "case", matcher, "2026-09-30T00:00:00Z")

    page_1 = row("https://mdcomputers.in/product/nzxt-h5-flow/cabinet")
    page_4 = row("https://mdcomputers.in/product/nzxt-h5-flow/cabinet?page=4")

    assert page_1.url == page_4.url == "https://mdcomputers.in/product/nzxt-h5-flow"
    assert page_1.id == page_4.id == product_id("https://mdcomputers.in/product/nzxt-h5-flow")
