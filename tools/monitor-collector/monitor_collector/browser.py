from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT

LOG = logging.getLogger(__name__)
PLATFORM_HOME = {"facebook": "https://www.facebook.com/", "x": "https://x.com/home"}


def _engine() -> Any:
    if os.getenv("BROWSER_ENGINE", "playwright").strip().lower() == "patchright":
        try:
            from patchright.sync_api import sync_playwright
        except ImportError as exc:
            raise RuntimeError("BROWSER_ENGINE=patchright is set; install the optional patchright dependency") from exc
    else:
        from playwright.sync_api import sync_playwright
    return sync_playwright


def profile_dir(platform: str) -> Path:
    directory = PROJECT_ROOT / "data" / "browser-profiles" / platform
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def launch_context(playwright: Any, platform: str):
    """Launch installed Chrome, falling back to installed Edge; never override UA or viewport."""
    user_data_dir = str(profile_dir(platform))
    options = {
        "user_data_dir": user_data_dir,
        "headless": False,
        "no_viewport": True,
        "ignore_default_args": ["--enable-automation"],
        "args": ["--disable-notifications"],
    }
    try:
        return playwright.chromium.launch_persistent_context(channel="chrome", **options)
    except Exception as chrome_error:
        LOG.info("Installed Chrome could not be launched (%s); trying Edge", chrome_error)
        try:
            return playwright.chromium.launch_persistent_context(channel="msedge", **options)
        except Exception as edge_error:
            raise RuntimeError(f"Could not launch installed Chrome or Edge: {edge_error}") from edge_error


def manual_login(platform: str) -> None:
    if platform not in PLATFORM_HOME:
        raise ValueError("Platform must be facebook or x")
    sync_playwright = _engine()
    print(f"Log in to {platform} in the opened Chrome/Edge window. Passwords are not read or stored.")
    with sync_playwright() as playwright:
        context = launch_context(playwright, platform)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(PLATFORM_HOME[platform], wait_until="domcontentloaded", timeout=60_000)
            input("After you finish logging in, return here and press Enter to close the browser… ")
        finally:
            context.close()
