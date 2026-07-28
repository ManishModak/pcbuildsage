from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .models import ScrapedProduct
from .normalizer import classify_subcategory, reclassify_category

SCHEMA_VERSION = 4

# Keep in lockstep with LOGS_TABLE_DDL in src/lib/db.ts.
LOGS_TABLE_DDL = """
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT
    );
    CREATE TRIGGER IF NOT EXISTS limit_logs_size
    AFTER INSERT ON logs
    BEGIN
      DELETE FROM logs WHERE id IN (
        SELECT id FROM logs ORDER BY id DESC LIMIT -1 OFFSET 1000
      );
    END;
    """


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
        current_version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version < SCHEMA_VERSION:
            with self.conn:
                self._run_migrations(current_version)
                self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              normalized_name TEXT,
              registry_key TEXT,
              price REAL,
              currency TEXT NOT NULL,
              country_code TEXT NOT NULL,
              retailer TEXT NOT NULL,
              url TEXT UNIQUE NOT NULL,
              image_url TEXT,
              in_stock INTEGER DEFAULT 1,
              category TEXT NOT NULL,
              subcategory TEXT,
              specs TEXT,
              first_seen TEXT NOT NULL,
              last_scraped TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(country_code, currency, category, subcategory, price);
            CREATE INDEX IF NOT EXISTS idx_products_norm ON products(normalized_name);
            CREATE INDEX IF NOT EXISTS idx_products_retailer_sweep ON products(retailer, category, last_scraped);
            """
        )

    def _run_migrations(self, from_version: int) -> None:
        if from_version < 1:
            pass  # v1 baseline: schema created by _initialize_schema
        if from_version < 2:
            pass
        if from_version < 3:
            cursor = self.conn.execute("PRAGMA table_info(products);")
            cols = [row["name"] for row in cursor.fetchall()]
            if not cols:
                return
            if "price_minor" in cols:
                self.conn.execute("ALTER TABLE products RENAME COLUMN price_minor TO price;")
                self.conn.execute("UPDATE products SET price = price / 100.0 WHERE price IS NOT NULL;")
            self.conn.execute("DROP INDEX IF EXISTS idx_products_lookup;")
            self.conn.execute("CREATE INDEX IF NOT EXISTS idx_products_lookup ON products(country_code, currency, category, price);")
        if from_version < 4:
            cursor = self.conn.execute("PRAGMA table_info(products);")
            cols = [row["name"] for row in cursor.fetchall()]
            if not cols:
                return
            if "subcategory" not in cols:
                self.conn.execute("ALTER TABLE products ADD COLUMN subcategory TEXT;")
            self._backfill_build_roles()
            self.conn.execute("DROP INDEX IF EXISTS idx_products_lookup;")

    def _backfill_build_roles(self) -> None:
        """Label every existing row with its build role, and correct misfilings.

        Rewrites only `category` and `subcategory`. It never deletes a row: a
        mislabelled product is one UPDATE away from correct, whereas a deleted
        one is gone silently, which is how 191 real products were once lost here.
        """
        rows = self.conn.execute("SELECT id, name, category FROM products").fetchall()
        updates = []
        for row in rows:
            category = reclassify_category(row["name"], row["category"])
            updates.append(
                {
                    "id": row["id"],
                    "category": category,
                    "subcategory": classify_subcategory(row["name"], category),
                }
            )
        if updates:
            self.conn.executemany(
                "UPDATE products SET category = :category, subcategory = :subcategory WHERE id = :id",
                updates,
            )

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
            # Classify at the single write choke point so no scrape path can
            # smuggle a pen drive in under the retailer's "storage" shelf label.
            category = reclassify_category(product.name, product.category)
            subcategory = product.subcategory or classify_subcategory(product.name, category)
            rows.append(
                {
                    "id": product.id,
                    "name": product.name,
                    "normalized_name": product.normalized_name,
                    "registry_key": product.registry_key,
                    "price": product.price,
                    "currency": product.currency,
                    "country_code": product.country_code,
                    "retailer": product.retailer,
                    "url": product.url,
                    "image_url": product.image_url,
                    "in_stock": 1 if product.in_stock else 0,
                    "category": category,
                    "subcategory": subcategory,
                    "specs": json.dumps(product.specs, ensure_ascii=False) if product.specs else None,
                    "first_seen": product.first_seen or now,
                    "last_scraped": product.last_scraped or now,
                }
            )
        with self.conn:
            self.conn.executemany(
                """
                INSERT INTO products (
                    id, name, normalized_name, registry_key, price, currency,
                    country_code, retailer, url, image_url, in_stock, category, subcategory,
                    specs, first_seen, last_scraped
                ) VALUES (
                    :id, :name, :normalized_name, :registry_key, :price, :currency,
                    :country_code, :retailer, :url, :image_url, :in_stock, :category, :subcategory,
                    :specs, :first_seen, :last_scraped
                )
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    normalized_name = excluded.normalized_name,
                    registry_key = excluded.registry_key,
                    price = excluded.price,
                    currency = excluded.currency,
                    country_code = excluded.country_code,
                    retailer = excluded.retailer,
                    url = excluded.url,
                    image_url = excluded.image_url,
                    in_stock = excluded.in_stock,
                    category = excluded.category,
                    subcategory = excluded.subcategory,
                    specs = excluded.specs,
                    last_scraped = excluded.last_scraped
                """,
                rows,
            )
        return len(rows)

    def count_in_stock(self, retailer: str, category: str) -> int:
        """Rows currently marked in stock for a retailer/category.

        Read before a run's upserts to give sweep_stale_stock a baseline: a
        crawl that returns far fewer products than are on record is more likely
        a partially blocked crawl than a real inventory collapse.
        """
        row = self.conn.execute(
            """
            SELECT COUNT(*) FROM products
            WHERE retailer = ? AND category = ? AND in_stock = 1
            """,
            (retailer, category),
        ).fetchone()
        return int(row[0]) if row else 0

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


class SQLiteLogHandler(logging.Handler):
    def __init__(self, db_path: str | Path) -> None:
        super().__init__()
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA busy_timeout=5000;")
        self._initialize_schema()

    def _initialize_schema(self) -> None:
        self.conn.executescript(LOGS_TABLE_DDL)
        self.conn.commit()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = record.levelname
            if level == "WARNING":
                level = "WARN"

            component = getattr(record, "component", None)
            if not component:
                name_parts = record.name.split(".")
                component = name_parts[-1] if name_parts else "scraper"

            details = getattr(record, "details", None)
            details_str = json.dumps(details, ensure_ascii=False) if details is not None else None

            message = record.getMessage()

            with self.lock:
                self.conn.execute(
                    """
                    INSERT INTO logs (timestamp, level, component, message, details)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (utc_now_iso(), level, component, message, details_str)
                )
                self.conn.commit()
        except Exception:
            self.handleError(record)

    def close(self) -> None:
        with self.lock:
            try:
                self.conn.close()
            except Exception:
                pass
        super().close()

