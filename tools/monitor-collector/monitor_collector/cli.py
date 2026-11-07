from __future__ import annotations

import argparse
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from .browser import manual_login
from .collector import run_collection
from .config import PROJECT_ROOT
from .logging_setup import configure_logging


def main() -> None:
    parser = argparse.ArgumentParser(prog="monitor_collector")
    commands = parser.add_subparsers(dest="command", required=True)
    login = commands.add_parser("login", help="open the saved Chrome/Edge profile for manual sign-in")
    login.add_argument("platform", choices=("facebook", "x"))
    run = commands.add_parser("run", help="collect the next active profiles and send them to SzroNox")
    run.add_argument("--force", action="store_true", help="run even if a successful collection already ran today")
    args = parser.parse_args()
    configure_logging()
    if args.command == "login":
        manual_login(args.platform)
        return
    stamp = PROJECT_ROOT / "data" / "last-successful-run.txt"
    today = datetime.now(ZoneInfo("Europe/Warsaw")).date().isoformat()
    if not args.force and stamp.exists() and stamp.read_text(encoding="utf-8").strip() == today:
        logging.getLogger(__name__).info("A successful collection already ran today; skipping")
        return
    try:
        run_collection()
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(today, encoding="utf-8")
    except Exception:
        logging.getLogger(__name__).exception("Monitor collection run failed")
        raise
