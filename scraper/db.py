from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .models import ScrapedProduct
from .normalizer import classify_subcategory, reclassify_category

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 5
CATALOG_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "data" / "schemas" / "catalog-v5.sql"
MAX_LOG_DETAILS_BYTES = 16 * 1024
SENSITIVE_LOG_KEYS = ("apikey", "api_key", "authorization", "cookie", "password", "secret", "token")

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


def serialize_log_details(details: object) -> str:
    def redact(value: object) -> object:
        if isinstance(value, dict):
            return {
                str(key): "[redacted]" if any(secret in str(key).lower() for secret in SENSITIVE_LOG_KEYS) else redact(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    def truncate_strings(value: object, max_len: int) -> object:
        if isinstance(value, str):
            if len(value) > max_len:
                return value[:max_len] + "... [truncated]"
            return value
        if isinstance(value, dict):
            return {str(k): truncate_strings(v, max_len) for k, v in value.items()}
        if isinstance(value, list):
            return [truncate_strings(v, max_len) for v in value]
        return value

    redacted = redact(details)
    serialized = json.dumps(redacted, ensure_ascii=False, default=str)
    byte_count = len(serialized.encode("utf-8"))
    if byte_count <= MAX_LOG_DETAILS_BYTES:
        return serialized

    max_len = 1000
    while max_len > 0:
        truncated = truncate_strings(redacted, max_len)
        serialized = json.dumps(truncated, ensure_ascii=False, default=str)
        if len(serialized.encode("utf-8")) <= MAX_LOG_DETAILS_BYTES:
            return serialized
        max_len //= 2

    truncated = truncate_strings(redacted, 0)
    serialized = json.dumps(truncated, ensure_ascii=False, default=str)
    if len(serialized.encode("utf-8")) <= MAX_LOG_DETAILS_BYTES:
        return serialized

    return json.dumps({"truncated": True, "original_bytes": byte_count})


def sweep_skip_reason(found: int, previous_in_stock: int, min_ratio: float, force: bool) -> str | None:
    if force:
        return None
    if found == 0:
        return "crawl returned no products"
    if previous_in_stock == 0:
        return None
    if found < previous_in_stock * min_ratio:
        return (
            f"found {found} products but {previous_in_stock} were in stock "
            f"(below the {min_ratio:.0%} threshold); suspected partial crawl"
        )
    return None


class ProductStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA busy_timeout=5000;")
        try:
            self._initialize_schema()
        except Exception:
            self.conn.close()
            raise

    def _initialize_schema(self) -> None:
        current_version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version > SCHEMA_VERSION:
            raise RuntimeError(
                f"Database schema version {current_version} is newer than supported version "
                f"{SCHEMA_VERSION}. Update PCBuildSage before opening this database."
            )

        with self.conn:
            if current_version < SCHEMA_VERSION:
                self._run_migrations(current_version)
            self._apply_canonical_schema()
            self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

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
            self.conn.execute("DROP INDEX IF EXISTS idx_products_lookup;")
        if from_version < 5:
            # v4 files created by the former TypeScript bootstrap can contain
            # NULL build roles even though their version stamp says current.
            self._backfill_build_roles()
            self._rebuild_products_v5()

    def _rebuild_products_v5(self) -> None:
        """Rebuild legacy products, merging duplicate URLs deterministically."""
        columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(products)").fetchall()}
        if not columns:
            return

        self.conn.execute("ALTER TABLE products RENAME TO products_legacy_v4")
        duplicate_count = self.conn.execute(
            "SELECT COUNT(*) - COUNT(DISTINCT url) FROM products_legacy_v4"
        ).fetchone()[0]
        if duplicate_count:
            logger.warning(
                "Merging %d duplicate legacy product URL rows during v5 migration",
                duplicate_count,
                extra={"component": "database"},
            )
        self._apply_canonical_schema()
        self.conn.execute(
            """
            INSERT INTO products (
              id, name, normalized_name, registry_key, price, currency,
              country_code, retailer, url, image_url, in_stock, category,
              subcategory, specs, first_seen, last_scraped
            )
            SELECT
              id, name, normalized_name, registry_key, price, currency,
              country_code, retailer, url, image_url, in_stock, category,
              subcategory, specs, first_seen, last_scraped
            FROM (
              SELECT *, ROW_NUMBER() OVER (
                PARTITION BY url
                ORDER BY last_scraped DESC, first_seen ASC, id ASC
              ) AS url_rank
              FROM products_legacy_v4
            )
            WHERE url_rank = 1
            """
        )
        self.conn.execute("DROP TABLE products_legacy_v4")

    def _apply_canonical_schema(self) -> None:
        for statement in CATALOG_SCHEMA_PATH.read_text(encoding="utf-8").split(";"):
            if statement.strip():
                self.conn.execute(statement)

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
        with self.conn:
            return self._upsert_products(products, scraped_at)

    def _upsert_products(self, products: list[ScrapedProduct], scraped_at: str | None = None) -> int:
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
        return self._count_in_stock(retailer, category)

    def _count_in_stock(self, retailer: str, category: str) -> int:
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
            return self._sweep_stale_stock(retailer, category, run_started_at)

    def _sweep_stale_stock(self, retailer: str, category: str, run_started_at: str) -> int:
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

    def apply_category_snapshot(
        self,
        products: list[ScrapedProduct],
        *,
        retailer: str,
        category: str,
        run_started_at: str,
        scraped_at: str | None = None,
        sweep_min_ratio: float = 0.5,
        force_sweep: bool = False,
    ) -> tuple[int, str | None]:
        """Atomically upsert and optionally retire one retailer/category snapshot."""
        with self.conn:
            previous_in_stock = self._count_in_stock(retailer, category)
            written = self._upsert_products(products, scraped_at) if products else 0
            skip_reason = sweep_skip_reason(
                found=len(products),
                previous_in_stock=previous_in_stock,
                min_ratio=sweep_min_ratio,
                force=force_sweep,
            )
            if skip_reason is None:
                self._sweep_stale_stock(retailer, category, run_started_at)
            return written, skip_reason

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
            details_str = serialize_log_details(details) if details is not None else None

            message = record.getMessage()

            with self.lock:
                try:
                    self.conn.execute(
                        """
                        INSERT INTO logs (timestamp, level, component, message, details)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (utc_now_iso(), level, component, message, details_str)
                    )
                    self.conn.commit()
                except Exception:
                    try:
                        self.conn.rollback()
                    except Exception:
                        pass
                    raise
        except Exception:
            self.handleError(record)

    def close(self) -> None:
        with self.lock:
            try:
                self.conn.close()
            except Exception:
                pass
        super().close()
