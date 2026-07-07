from __future__ import annotations

import json

import pytest

from scraper.config import ProfileError, load_profile


def test_profile_loader_rejects_malformed_profile(tmp_path) -> None:
    profile = tmp_path / "bad.json"
    profile.write_text(
        json.dumps(
            {
                "$schema": "../schemas/profile.schema.json",
                "schema_version": 1,
                "profile_name": "Bad",
                "country_code": "IN",
                "default_currency": "INR",
                "sites": [
                    {
                        "site_name": "Broken",
                        "base_url": "https://example.com/",
                        "scraping_type": "category",
                        "browser_config": {"headless": True, "js_rendering": True, "timeout_ms": 30000},
                        "categories": {"gpu": {"path": "gpu", "max_pages": 1}},
                        "selectors": {"product_container": ".product", "title": ".title", "url": "a"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ProfileError):
        load_profile(profile)


def test_profile_loader_accepts_existing_india_profile() -> None:
    profile = load_profile("india")
    assert profile.country_code == "IN"
    assert profile.sites
