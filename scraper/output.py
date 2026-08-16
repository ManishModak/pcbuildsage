from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any


def configure_logging(log_path: str | Path = "logs/scraping.log") -> logging.Logger:
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("scraper")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(formatter)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(stream)
    logger.addHandler(file_handler)
    logger.propagate = False
    return logger


class EventEmitter:
    VALID_TYPES = {"progress", "site_started", "site_failed", "sweep_skipped", "done", "error"}

    def __init__(self, json_stdout: bool, logger: logging.Logger | None = None) -> None:
        self.json_stdout = json_stdout
        self.logger = logger or logging.getLogger("scraper")

    def emit(self, event_type: str, **payload: Any) -> None:
        if event_type not in self.VALID_TYPES:
            raise ValueError(f"invalid event type: {event_type}")
        event = {"type": event_type, **payload}
        if self.json_stdout:
            print(json.dumps(event, ensure_ascii=False), flush=True)
        else:
            self.logger.info("%s %s", event_type, " ".join(f"{k}={v}" for k, v in payload.items()))

    def progress(self, **payload: Any) -> None:
        self.emit("progress", **payload)
