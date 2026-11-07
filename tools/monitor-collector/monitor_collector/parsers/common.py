from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

from bs4 import Tag


def absolute(href: str, base_url: str) -> str:
    return urljoin(base_url, href.split("#", 1)[0])


def parse_timestamp(value: str | None, now: datetime | None = None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat()
    except ValueError:
        pass
    text = raw.casefold().replace("’", "'")
    current = now or datetime.now(timezone.utc)
    relative = re.search(r"(\d+)\s*(s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|godz\.?|min\.?|dni|dzień|dniu)", text)
    if relative:
        amount = int(relative.group(1))
        unit = relative.group(2)
        if unit.startswith("s"):
            delta = timedelta(seconds=amount)
        elif unit.startswith("m"):
            delta = timedelta(minutes=amount)
        elif unit.startswith("h") or unit.startswith("godz"):
            delta = timedelta(hours=amount)
        else:
            delta = timedelta(days=amount)
        return (current - delta).isoformat()
    if any(word in text for word in ("yesterday", "wczoraj")):
        return (current - timedelta(days=1)).isoformat()
    return None


def is_nested_article(node: Tag) -> bool:
    parent = node.parent
    while isinstance(parent, Tag):
        if parent.name == "article" or parent.get("role") == "article":
            return True
        parent = parent.parent
    return False


def is_in_nested_article(node: Tag, root: Tag) -> bool:
    parent = node.parent
    while isinstance(parent, Tag) and parent is not root:
        if parent.name == "article" or parent.get("role") == "article":
            return True
        parent = parent.parent
    return False


def visible_label_text(node: Tag) -> str:
    labels = [str(value) for value in node.select("[aria-label]") for value in [value.get("aria-label", "")]]
    return " ".join(labels + [node.get_text(" ", strip=True)]).casefold()
