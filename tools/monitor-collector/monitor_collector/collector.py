from __future__ import annotations

import logging
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .api import MonitorApi
from .browser import _engine, launch_context
from .config import PROJECT_ROOT, env_float, env_int
from .models import Post
from .parsers import facebook, x

LOG = logging.getLogger(__name__)
PARSERS = {"facebook": facebook, "x": x}


class LoginWallError(RuntimeError):
    pass


class ParseFailure(RuntimeError):
    pass


def _safe_filename(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", value).strip("_")[:60] or "source"


def _save_debug(page: Any, source_id: str, platform: str, reason: str, html: str | None = None) -> None:
    directory = PROJECT_ROOT / "logs" / "debug"
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = f"{stamp}-{platform}-{_safe_filename(source_id)}"
    try:
        page_content = html if html is not None else page.content()
        (directory / f"{stem}.html").write_text(page_content, encoding="utf-8")
    except Exception:
        LOG.exception("Could not save diagnostic HTML after %s", reason)
    try:
        page.screenshot(path=str(directory / f"{stem}.png"), full_page=True, timeout=20_000)
    except Exception:
        LOG.exception("Could not save screenshot after %s", reason)
    LOG.warning("Saved HTML and screenshot for %s: %s", source_id, reason)


def _expand_more(page: Any, platform: str) -> None:
    selectors = ("text=See more", "text=Zobacz więcej")
    for selector in selectors:
        try:
            buttons = page.locator(selector)
            for index in range(min(buttons.count(), 30)):
                button = buttons.nth(index)
                if button.is_visible(timeout=250):
                    button.click(timeout=700, force=True)
        except Exception:
            continue


def _wait_first_post(page: Any, parser: Any, source_url: str) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        html = page.content()
        if parser.is_login_wall(page.url, html):
            raise LoginWallError(f"login wall or checkpoint at {page.url}")
        if parser.has_post_markup(html):
            return
        page.wait_for_timeout(500)
    LOG.warning("No first post appeared within 15 seconds for %s", source_url)


def _age_cutoff() -> datetime:
    hours = env_float("MAX_POST_AGE_HOURS", 48.0, 1.0, 24 * 365)
    return datetime.now(timezone.utc) - timedelta(hours=hours)


def _is_fresh(post: Post, cutoff: datetime) -> bool:
    if not post.published_at:
        return True
    try:
        value = datetime.fromisoformat(post.published_at.replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value >= cutoff
    except ValueError:
        return True


def _post_payload(post: Post) -> dict[str, Any]:
    return {
        "url": post.url, "author": post.author[:300], "publishedAt": post.published_at,
        "text": post.text[:20_000], "media": [item[:2048] for item in post.media[:20]],
        "engagement": {key[:40]: value[:40] for key, value in list(post.engagement.items())[:8]},
        "isRepost": post.is_repost, "isPinned": post.is_pinned,
    }


def _collect_source(page: Any, source: dict[str, Any], max_scrolls: int, cutoff: datetime) -> tuple[list[Post], int]:
    platform = source["platform"]
    parser = PARSERS[platform]
    page.goto(source["profileUrl"], wait_until="domcontentloaded", timeout=60_000)
    _wait_first_post(page, parser, source["profileUrl"])

    accumulated: dict[str, Post] = {}
    consecutive_known = 0
    seen_timeline: set[str] = set()
    parse_ok = False
    known_urls = set(source.get("knownUrls") or [])
    for scroll_number in range(max_scrolls + 1):
        _expand_more(page, platform)
        html = page.content()
        if parser.is_login_wall(page.url, html):
            raise LoginWallError(f"login wall or checkpoint at {page.url}")
        posts = parser.parse_posts(html, page.url)
        if posts:
            parse_ok = True
        for post in posts:
            if post.url not in seen_timeline:
                seen_timeline.add(post.url)
                if not post.is_repost and not post.is_pinned:
                    if post.url in known_urls:
                        consecutive_known += 1
                    else:
                        consecutive_known = 0
                if _is_fresh(post, cutoff):
                    accumulated.setdefault(post.url, post)
        if consecutive_known >= 3 or scroll_number >= max_scrolls:
            break
        delay = random.uniform(env_float("MIN_DELAY_SECONDS", 1.2), max(
            env_float("MIN_DELAY_SECONDS", 1.2), env_float("MAX_DELAY_SECONDS", 3.0)))
        page.wait_for_timeout(int(delay * 1000))
        page.evaluate("window.scrollBy(0, window.innerHeight)")
        page.wait_for_timeout(random.randint(500, 1_200))

    if not parse_ok:
        _save_debug(page, str(source["id"]), platform, "no posts were parsed")
        raise ParseFailure("no posts were parsed from the profile page")
    return list(accumulated.values()), len(seen_timeline)


def _post_batches(api: MonitorApi, run_id: str, source_id: str, posts: list[Post]) -> int:
    inserted = 0
    for start in range(0, len(posts), 100):
        batch = posts[start:start + 100]
        body = {"runId": run_id, "sourceId": source_id, "posts": [_post_payload(post) for post in batch]}
        response = api.post_or_queue("/monitor/collect/posts", body)
        if isinstance(response, dict):
            inserted += int(response.get("inserted", 0))
            rejected = response.get("rejected", [])
            if rejected:
                LOG.warning("SzroNox rejected %d post(s) for source %s: %s", len(rejected), source_id, rejected[:10])
    return inserted


def run_collection() -> None:
    api = MonitorApi()
    api.replay_outbox()
    run_id = str(uuid4())
    api.post("/monitor/collect/runs", {"runId": run_id})
    limit = env_int("MAX_PROFILES_PER_RUN", 4, 1, 20)
    sources_response = api.get(f"/monitor/collect/sources?limit={limit}")
    sources = sources_response.get("items", []) if isinstance(sources_response, dict) else []
    results: list[dict[str, Any]] = []
    blocked_platforms: set[str] = set()
    cutoff = _age_cutoff()
    sync_playwright = _engine()
    max_scrolls = env_int("MAX_SCROLLS", 8, 0, 100)

    with sync_playwright() as playwright:
        for source in sources:
            source_id = str(source.get("id", ""))
            platform = str(source.get("platform", ""))
            status = "ok"
            seen = new = 0
            if platform in blocked_platforms:
                results.append({"sourceId": source_id, "status": "login_wall", "seen": 0, "new": 0})
                continue
            context = None
            page = None
            try:
                context = launch_context(playwright, platform)
                page = context.pages[0] if context.pages else context.new_page()
                posts, seen = _collect_source(page, source, max_scrolls, cutoff)
                new = _post_batches(api, run_id, source_id, posts)
                LOG.info("Collected %d posts (%d new) from source %s", seen, new, source_id)
            except LoginWallError as exc:
                blocked_platforms.add(platform)
                status = "login_wall"
                LOG.error("Skipping %s for this run: %s. Run python -m monitor_collector login %s.", platform, exc, platform)
            except ParseFailure as exc:
                status = "parse_failure"
                LOG.error("Source %s could not be parsed: %s", source_id, exc)
            except Exception:
                status = "error"
                LOG.exception("Source failed; continuing with remaining profiles: %s", source_id)
                if page is not None:
                    _save_debug(page, source_id, platform, "source collection exception")
            finally:
                if context is not None:
                    try:
                        context.close()
                    except Exception:
                        LOG.exception("Could not close browser context for %s", source_id)
            results.append({"sourceId": source_id, "status": status, "seen": seen, "new": new})
            time.sleep(random.uniform(env_float("MIN_DELAY_SECONDS", 1.2), max(
                env_float("MIN_DELAY_SECONDS", 1.2), env_float("MAX_DELAY_SECONDS", 3.0))))

    api.post_or_queue(f"/monitor/collect/runs/{run_id}/finish", {"results": results})
    LOG.info("Run %s finished with %d source results", run_id, len(results))
