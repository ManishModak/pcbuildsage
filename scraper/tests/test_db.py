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
        price=100.0,
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
        price=200.0,
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


def test_sqlite_logging_handler(tmp_path) -> None:
    import json
    import logging
    from scraper.db import SQLiteLogHandler
    
    db = tmp_path / "logs.db"
    handler = SQLiteLogHandler(db)
    
    logger = logging.getLogger("test_sqlite_logger")
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    
    # Send logs
    logger.info("Test info message", extra={"component": "test_comp", "details": {"foo": "bar"}})
    logger.warning("Test warning message")
    
    # Retrieve logs directly from SQLite database to verify
    import sqlite3
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM logs ORDER BY id").fetchall()
    conn.close()
    
    assert len(rows) == 2
    assert rows[0]["level"] == "INFO"
    assert rows[0]["component"] == "test_comp"
    assert rows[0]["message"] == "Test info message"
    assert json.loads(rows[0]["details"]) == {"foo": "bar"}
    
    assert rows[1]["level"] == "WARN"
    assert rows[1]["component"] == "test_sqlite_logger"
    assert rows[1]["message"] == "Test warning message"
    assert rows[1]["details"] is None
    
    logger.removeHandler(handler)
    handler.close()


def test_logs_truncation_trigger(tmp_path) -> None:
    import logging
    from scraper.db import SQLiteLogHandler
    
    db = tmp_path / "logs.db"
    handler = SQLiteLogHandler(db)
    
    logger = logging.getLogger("test_trigger_logger")
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    
    # Insert 1050 logs
    for i in range(1050):
        logger.info(f"Log msg {i}")
        
    # Verify database has exactly 1000 logs remaining
    import sqlite3
    conn = sqlite3.connect(db)
    count = conn.execute("SELECT COUNT(*) FROM logs").fetchone()[0]
    
    # Verify the remaining logs are the most recent ones (i.e. Log msg 50 to Log msg 1049)
    first_remaining = conn.execute("SELECT message FROM logs ORDER BY id ASC LIMIT 1").fetchone()[0]
    last_remaining = conn.execute("SELECT message FROM logs ORDER BY id DESC LIMIT 1").fetchone()[0]
    conn.close()
    
    assert count == 1000
    assert first_remaining == "Log msg 50"
    assert last_remaining == "Log msg 1049"
    
    logger.removeHandler(handler)
    handler.close()


def test_database_index_optimization(tmp_path) -> None:
    # First, initialize version 1 schema database manually
    import sqlite3
    db = tmp_path / "products.db"
    conn = sqlite3.connect(db)
    conn.execute(
        """
        CREATE TABLE products (
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
        """
    )
    conn.execute("CREATE INDEX idx_products_lookup ON products(country_code, category, price_minor);")
    conn.execute("PRAGMA user_version = 1;")
    conn.close()
    
    # Now instantiate ProductStore (version 4 schema), which should run migration and update index
    with ProductStore(db) as store:
        # Check index columns
        index_info = store.conn.execute("PRAGMA index_info(idx_products_lookup)").fetchall()
        columns = [row[2] for row in index_info]
        version = store.conn.execute("PRAGMA user_version").fetchone()[0]
        
    assert columns == ["country_code", "currency", "category", "subcategory", "price"]
    assert version == SCHEMA_VERSION


def test_was_scraped_since(tmp_path) -> None:
    from datetime import UTC, datetime, timedelta
    db = tmp_path / "products.db"
    
    with ProductStore(db) as store:
        assert not store.was_scraped_since("Shop", "gpu", hours=4)
        
    # Scraped 3 hours ago
    scraped_3h_ago = (datetime.now(UTC) - timedelta(hours=3)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    p1 = ScrapedProduct(
        id="p1",
        name="GPU 1",
        normalized_name="gpu 1",
        registry_key=None,
        price=150.0,
        currency="USD",
        country_code="US",
        retailer="Shop",
        url="https://example.com/p1",
        image_url=None,
        in_stock=True,
        category="gpu",
        first_seen=scraped_3h_ago,
        last_scraped=scraped_3h_ago,
    )
    with ProductStore(db) as store:
        store.upsert_products([p1], scraped_at=scraped_3h_ago)
        
        # threshold 4 hours: 3 hours ago >= 4 hours ago -> True
        assert store.was_scraped_since("Shop", "gpu", hours=4)
        
        # threshold 2 hours: 3 hours ago >= 2 hours ago -> False
        assert not store.was_scraped_since("Shop", "gpu", hours=2)
        
        # different retailer -> False
        assert not store.was_scraped_since("OtherShop", "gpu", hours=4)
        
        # different category -> False
        assert not store.was_scraped_since("Shop", "cpu", hours=4)



def _product(pid: str, retailer: str = "Shop", category: str = "gpu", in_stock: bool = True) -> ScrapedProduct:
    return ScrapedProduct(
        id=pid,
        name=f"GPU {pid}",
        normalized_name=f"gpu {pid}",
        registry_key=None,
        price=100.0,
        currency="INR",
        country_code="IN",
        retailer=retailer,
        url=f"https://example.com/{pid}",
        image_url=None,
        in_stock=in_stock,
        category=category,
        first_seen="2026-01-01T00:00:00Z",
        last_scraped="2026-01-01T00:00:00Z",
    )


def test_count_in_stock_ignores_retired_rows_and_other_categories(tmp_path) -> None:
    db = tmp_path / "products.db"
    with ProductStore(db) as store:
        store.upsert_products(
            [
                _product("a"),
                _product("b"),
                _product("c", in_stock=False),
                _product("d", category="cpu"),
                _product("e", retailer="Other"),
            ]
        )
        assert store.count_in_stock("Shop", "gpu") == 2
        assert store.count_in_stock("Shop", "cpu") == 1
        assert store.count_in_stock("Nobody", "gpu") == 0
