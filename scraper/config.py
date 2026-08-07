from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import BrowserConfig, CategoryConfig, ProfileConfig, SiteConfig


class ProfileError(ValueError):
    """Raised when a scraper profile fails validation."""


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILES_DIR = REPO_ROOT / "data" / "profiles"


def _require(value: dict[str, Any], key: str, expected: type | tuple[type, ...]) -> Any:
    if key not in value:
        raise ProfileError(f"missing required field: {key}")
    if not isinstance(value[key], expected):
        raise ProfileError(f"field {key} has invalid type")
    return value[key]


def _validate_profile(raw: dict[str, Any]) -> None:
    for key in ("$schema", "schema_version", "profile_name", "country_code", "default_currency", "sites"):
        _require(raw, key, (str, int, list) if key == "schema_version" else object)
    if not isinstance(raw["schema_version"], int) or raw["schema_version"] < 1:
        raise ProfileError("schema_version must be a positive integer")
    if not isinstance(raw["profile_name"], str) or not raw["profile_name"]:
        raise ProfileError("profile_name must be a non-empty string")
    if not isinstance(raw["country_code"], str) or len(raw["country_code"]) != 2 or not raw["country_code"].isupper():
        raise ProfileError("country_code must be an uppercase ISO-3166 alpha-2 code")
    if not isinstance(raw["default_currency"], str) or len(raw["default_currency"]) != 3 or not raw["default_currency"].isupper():
        raise ProfileError("default_currency must be an uppercase ISO-4217 code")
    if not isinstance(raw["sites"], list) or not raw["sites"]:
        raise ProfileError("sites must be a non-empty list")

    for site in raw["sites"]:
        if not isinstance(site, dict):
            raise ProfileError("site entries must be objects")
        for key in ("site_name", "base_url", "scraping_type", "browser_config", "categories", "selectors"):
            _require(site, key, object)
        if site["scraping_type"] not in {"category", "search"}:
            raise ProfileError(f"{site['site_name']}: scraping_type must be category or search")
        if not isinstance(site["browser_config"], dict):
            raise ProfileError(f"{site['site_name']}: browser_config must be an object")
        if not isinstance(site["categories"], dict) or not site["categories"]:
            raise ProfileError(f"{site['site_name']}: categories must be a non-empty object")
        if not isinstance(site["selectors"], dict):
            raise ProfileError(f"{site['site_name']}: selectors must be an object")
        for selector in ("product_container", "title", "price", "url"):
            if not isinstance(site["selectors"].get(selector), str) or not site["selectors"][selector]:
                raise ProfileError(f"{site['site_name']}: missing selector {selector}")
        browser = site["browser_config"]
        for key in ("headless", "js_rendering"):
            if not isinstance(browser.get(key), bool):
                raise ProfileError(f"{site['site_name']}: browser_config.{key} must be boolean")
        if not isinstance(browser.get("timeout_ms"), int) or browser["timeout_ms"] < 1000:
            raise ProfileError(f"{site['site_name']}: browser_config.timeout_ms must be >= 1000")
        if "wait_for_selector" in browser and browser["wait_for_selector"] is not None and not isinstance(browser["wait_for_selector"], str):
            raise ProfileError(f"{site['site_name']}: browser_config.wait_for_selector must be a string")
        if "scroll_down" in browser and not isinstance(browser["scroll_down"], bool):
            raise ProfileError(f"{site['site_name']}: browser_config.scroll_down must be boolean")
        for category_name, category in site["categories"].items():
            if not isinstance(category_name, str) or not category_name:
                raise ProfileError(f"{site['site_name']}: category names must be non-empty strings")
            if not isinstance(category, dict):
                raise ProfileError(f"{site['site_name']}/{category_name}: category must be an object")
            if not isinstance(category.get("path"), str):
                raise ProfileError(f"{site['site_name']}/{category_name}: path must be a string")
            if not isinstance(category.get("max_pages"), int) or category["max_pages"] < 1:
                raise ProfileError(f"{site['site_name']}/{category_name}: max_pages must be >= 1")
            if "pagination_pattern" in category and "{page}" not in category["pagination_pattern"]:
                raise ProfileError(f"{site['site_name']}/{category_name}: pagination_pattern must include {{page}}")
            if "search_pattern" in category and "{query}" not in category["search_pattern"]:
                raise ProfileError(f"{site['site_name']}/{category_name}: search_pattern must include {{query}}")


def resolve_profile_path(profile: str | Path, profiles_dir: Path = DEFAULT_PROFILES_DIR) -> Path:
    path = Path(profile)
    if path.exists():
        return path
    if path.suffix != ".json":
        path = Path(f"{profile}.json")
    candidate = profiles_dir / path.name
    if candidate.exists():
        return candidate
    raise ProfileError(f"profile not found: {profile}")


def load_profile(profile: str | Path, profiles_dir: Path = DEFAULT_PROFILES_DIR) -> ProfileConfig:
    path = resolve_profile_path(profile, profiles_dir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ProfileError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ProfileError("profile root must be an object")
    _validate_profile(raw)
    sites: list[SiteConfig] = []
    for raw_site in raw["sites"]:
        browser = BrowserConfig(
            headless=raw_site["browser_config"]["headless"],
            js_rendering=raw_site["browser_config"]["js_rendering"],
            wait_for_selector=raw_site["browser_config"].get("wait_for_selector"),
            scroll_down=raw_site["browser_config"].get("scroll_down", False),
            timeout_ms=raw_site["browser_config"]["timeout_ms"],
        )
        categories = {
            name: CategoryConfig(
                name=name,
                path=category["path"],
                pagination_pattern=category.get("pagination_pattern"),
                search_pattern=category.get("search_pattern"),
                max_pages=category["max_pages"],
            )
            for name, category in raw_site["categories"].items()
        }
        sites.append(
            SiteConfig(
                site_name=raw_site["site_name"],
                base_url=raw_site["base_url"],
                scraping_type=raw_site["scraping_type"],
                browser_config=browser,
                categories=categories,
                selectors=raw_site["selectors"],
                country_code=raw["country_code"],
                currency=raw["default_currency"],
                max_llm_calls_per_site=raw_site.get("max_llm_calls_per_site"),
            )
        )
    return ProfileConfig(
        source_path=str(path),
        schema_version=raw["schema_version"],
        profile_name=raw["profile_name"],
        country_code=raw["country_code"],
        default_currency=raw["default_currency"],
        sites=sites,
    )


def filter_sites(profile: ProfileConfig, site_names: list[str] | None) -> list[SiteConfig]:
    if not site_names:
        return profile.sites
    wanted = {name.casefold() for name in site_names}
    sites = [site for site in profile.sites if site.site_name.casefold() in wanted]
    missing = wanted - {site.site_name.casefold() for site in sites}
    if missing:
        raise ProfileError(f"unknown site(s): {', '.join(sorted(missing))}")
    return sites


def resolve_categories(site: SiteConfig, category_names: list[str] | None) -> list[CategoryConfig]:
    if not category_names:
        return list(site.categories.values())
    missing = [name for name in category_names if name not in site.categories]
    if missing:
        raise ProfileError(f"{site.site_name}: unknown category/categories: {', '.join(missing)}")
    return [site.categories[name] for name in category_names]
