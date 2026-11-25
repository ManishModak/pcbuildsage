from __future__ import annotations

import json

import pytest

from scraper.config import ProfileError, filter_sites, load_profile


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
    assert len(profile.sites) >= 15
    prime = next(s for s in profile.sites if s.site_name == "PrimeABGB")
    assert prime.categories["storage"].all_paths == ("ssd", "internal-hard-drive")


def test_profile_loader_rejects_empty_or_invalid_multi_path(tmp_path) -> None:
    profile = json.loads(open("data/profiles/india.json").read())
    prime = next(s for s in profile["sites"] if s["site_name"] == "PrimeABGB")
    prime["categories"]["storage"]["path"] = []
    target = tmp_path / "empty_paths.json"
    target.write_text(json.dumps(profile), encoding="utf-8")
    with pytest.raises(ProfileError, match="non-empty list"):
        load_profile(target)

    prime["categories"]["storage"]["path"] = ["ssd", "bad/slug"]
    target.write_text(json.dumps(profile), encoding="utf-8")
    with pytest.raises(ProfileError, match="category slug"):
        load_profile(target)


def test_filter_sites_excludes_named_sites_and_rejects_unknown_names() -> None:
    profile = load_profile("india")
    names = [site.site_name for site in filter_sites(profile, None, ["pcstudio"])]
    assert "PCStudio" not in names
    assert len(names) == len(profile.sites) - 1
    assert [s.site_name for s in filter_sites(profile, ["MDComputers", "PCStudio"], ["PCStudio"])] == ["MDComputers"]
    with pytest.raises(ProfileError, match="unknown site"):
        filter_sites(profile, None, ["NoSuchShop"])
