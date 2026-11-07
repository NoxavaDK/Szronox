from __future__ import annotations

import logging
from pathlib import Path

from .config import PROJECT_ROOT


def configure_logging() -> None:
    log_dir = PROJECT_ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.FileHandler(log_dir / "collector.log", encoding="utf-8"), logging.StreamHandler()],
        force=True,
    )
