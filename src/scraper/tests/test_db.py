from __future__ import annotations

from scraper.db import SCHEMA_VERSION, ProductStore
from scraper.models import ScrapedProduct


def test_store_initializes_fresh_database_path(tmp_path) -> None:
    db = tmp_path / "nested" / "products.db"
    with ProductStore(db) as store:
        table = store.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'").fetchone()
        indexes = {
            row["name"]
            for row in store.conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'products'"
            ).fetchall()
        }
    assert table is not None
    assert {"idx_products_lookup", "idx_products_norm", "idx_products_retailer_sweep"}.issubset(indexes)


def test_fresh_database_is_stamped_with_schema_version(tmp_path) -> None:
    db = tmp_path / "products.db"
    with ProductStore(db) as store:
        version = store.conn.execute("PRAGMA user_version").fetchone()[0]
    assert version == SCHEMA_VERSION


def test_upsert_and_stale_stock_sweep(tmp_path) -> None:
    db = tmp_path / "products.db"
    old = ScrapedProduct(
        id="old",
        name="Old GPU",
        normalized_name="old gpu",
        registry_key=None,
        price_minor=10000,
        currency="INR",
        country_code="IN",
        retailer="Shop",
        url="https://example.com/old",
        image_url=None,
        in_stock=True,
        category="gpu",
        first_seen="2026-01-01T00:00:00Z",
        last_scraped="2026-01-01T00:00:00Z",
    )
    new = ScrapedProduct(
        id="new",
        name="New GPU",
        normalized_name="new gpu",
        registry_key=None,
        price_minor=20000,
        currency="INR",
        country_code="IN",
        retailer="Shop",
        url="https://example.com/new",
        image_url=None,
        in_stock=True,
        category="gpu",
        first_seen="2026-01-01T00:00:00Z",
        last_scraped="2026-07-07T00:00:00Z",
    )
    with ProductStore(db) as store:
        assert store.upsert_products([old]) == 1
        assert store.upsert_products([new], scraped_at="2026-07-07T00:00:00Z") == 1
        assert store.sweep_stale_stock("Shop", "gpu", "2026-07-01T00:00:00Z") == 1
        rows = {
            row["id"]: row["in_stock"]
            for row in store.conn.execute("SELECT id, in_stock FROM products ORDER BY id").fetchall()
        }
    assert rows == {"new": 1, "old": 0}
