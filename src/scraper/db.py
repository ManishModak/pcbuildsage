from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .models import ScrapedProduct

SCHEMA_VERSION = 1


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class ProductStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA busy_timeout=5000;")
        self._initialize_schema()

    def _initialize_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              normalized_name TEXT,
              registry_key TEXT,
              price_minor INTEGER,
              currency TEXT NOT NULL,
              country_code TEXT NOT NULL,
              retailer TEXT NOT NULL,
              url TEXT UNIQUE NOT NULL,
              image_url TEXT,
              in_stock INTEGER DEFAULT 1,
              category TEXT NOT NULL,
              specs TEXT,
              first_seen TEXT NOT NULL,
              last_scraped TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(country_code, category, price_minor);
            CREATE INDEX IF NOT EXISTS idx_products_norm ON products(normalized_name);
            CREATE INDEX IF NOT EXISTS idx_products_retailer_sweep ON products(retailer, category, last_scraped);
            """
        )
        current_version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version < SCHEMA_VERSION:
            self._run_migrations(current_version)
            self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _run_migrations(self, from_version: int) -> None:
        if from_version < 1:
            pass  # v1 baseline: schema created by _initialize_schema
        # future migrations: if from_version < 2: self.conn.execute("ALTER TABLE ...")

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "ProductStore":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def upsert_products(self, products: list[ScrapedProduct], scraped_at: str | None = None) -> int:
        if not products:
            return 0
        now = scraped_at or utc_now_iso()
        rows = []
        for product in products:
            rows.append(
                {
                    "id": product.id,
                    "name": product.name,
                    "normalized_name": product.normalized_name,
                    "registry_key": product.registry_key,
                    "price_minor": product.price_minor,
                    "currency": product.currency,
                    "country_code": product.country_code,
                    "retailer": product.retailer,
                    "url": product.url,
                    "image_url": product.image_url,
                    "in_stock": 1 if product.in_stock else 0,
                    "category": product.category,
                    "specs": json.dumps(product.specs, ensure_ascii=False) if product.specs else None,
                    "first_seen": product.first_seen or now,
                    "last_scraped": product.last_scraped or now,
                }
            )
        with self.conn:
            self.conn.executemany(
                """
                INSERT INTO products (
                    id, name, normalized_name, registry_key, price_minor, currency,
                    country_code, retailer, url, image_url, in_stock, category, specs,
                    first_seen, last_scraped
                ) VALUES (
                    :id, :name, :normalized_name, :registry_key, :price_minor, :currency,
                    :country_code, :retailer, :url, :image_url, :in_stock, :category, :specs,
                    :first_seen, :last_scraped
                )
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    normalized_name = excluded.normalized_name,
                    registry_key = excluded.registry_key,
                    price_minor = excluded.price_minor,
                    currency = excluded.currency,
                    country_code = excluded.country_code,
                    retailer = excluded.retailer,
                    url = excluded.url,
                    image_url = excluded.image_url,
                    in_stock = excluded.in_stock,
                    category = excluded.category,
                    specs = excluded.specs,
                    last_scraped = excluded.last_scraped
                """,
                rows,
            )
        return len(rows)

    def sweep_stale_stock(self, retailer: str, category: str, run_started_at: str) -> int:
        with self.conn:
            cursor = self.conn.execute(
                """
                UPDATE products
                SET in_stock = 0
                WHERE retailer = ?
                  AND category = ?
                  AND last_scraped < ?
                """,
                (retailer, category, run_started_at),
            )
        return cursor.rowcount

    def was_scraped_since(self, retailer: str, category: str, hours: int) -> bool:
        threshold = datetime.now(UTC) - timedelta(hours=hours)
        threshold_iso = threshold.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        row = self.conn.execute(
            """
            SELECT 1 FROM products
            WHERE retailer = ? AND category = ? AND last_scraped >= ?
            LIMIT 1
            """,
            (retailer, category, threshold_iso),
        ).fetchone()
        return row is not None
