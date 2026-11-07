from __future__ import annotations

import re
from datetime import datetime, timezone

from bs4 import BeautifulSoup, Tag

from ..canonical_url import canonical_post_url
from ..models import Post
from .common import absolute, is_in_nested_article, is_nested_article, parse_timestamp

# Keep Facebook-specific selectors here; profile markup changes frequently.
POST_SELECTORS = ('div[role="article"]', "article")
TEXT_SELECTORS = ('div[data-ad-preview="message"]', 'div[dir="auto"]')
AUTHOR_SELECTORS = ("h2 a", "h3 a", "strong a")
POST_HREF_MARKERS = ("/posts/", "story_fbid=", "permalink.php", "/videos/", "/reel/", "/photo", "photo.php", "/watch")
HEADER_SELECTORS = ("header", '[data-testid="story-subtitle"]', '[data-testid="post-header"]', '[data-ad-rendering-role="story_header"]')
REPOST_HEADER = re.compile(
    r"\b(?:shared\s+(?:a|this)\s+(?:post|link)|udostępnił(?:a|\(a\))?\s+(?:ten\s+)?post)\b", re.I
)
PINNED_HEADER = re.compile(r"\b(?:pinned\s+post|przypięt[yae]\s+post)\b", re.I)


def _post_header(article: Tag) -> str:
    for selector in HEADER_SELECTORS:
        for header in article.select(selector):
            if is_in_nested_article(header, article):
                continue
            label = header.get("aria-label", "")
            text = header.get_text(" ", strip=True)
            if label or text:
                return f"{label} {text}".casefold()
    return ""


def _post_url(article: Tag, base_url: str) -> str:
    for anchor in article.select("a[href]"):
        href = anchor.get("href", "")
        if any(marker in href for marker in POST_HREF_MARKERS):
            url, reason = canonical_post_url(absolute(href, base_url), "facebook")
            if url and reason is None:
                return url
    return ""


def _published_at(article: Tag) -> str | None:
    # The timestamp belongs to the post time link; do not accidentally choose a nested comment time.
    for link in article.select("a[href] time"):
        value = link.get("datetime") or link.get("title") or link.get("aria-label") or link.get_text(" ", strip=True)
        parsed = parse_timestamp(value)
        if parsed:
            return parsed
    for time_tag in article.select("time[datetime]"):
        if is_in_nested_article(time_tag, article):
            continue
        parsed = parse_timestamp(time_tag.get("datetime") or time_tag.get("title") or time_tag.get_text(" ", strip=True))
        if parsed:
            return parsed
    stamp = article.select_one("abbr[data-utime]")
    if stamp:
        try:
            return datetime.fromtimestamp(int(stamp["data-utime"]), timezone.utc).isoformat()
        except (ValueError, TypeError, OverflowError):
            return None
    # Older Facebook markup puts a localized relative date on the permalink itself.
    for anchor in article.select("a[href]"):
        if any(marker in anchor.get("href", "") for marker in POST_HREF_MARKERS):
            for value in (anchor.get("aria-label"), anchor.get("title"), anchor.get_text(" ", strip=True)):
                parsed = parse_timestamp(value)
                if parsed:
                    return parsed
    return None


def _author(article: Tag) -> str:
    for selector in AUTHOR_SELECTORS:
        candidate = article.select_one(selector)
        if candidate:
            value = candidate.get_text(" ", strip=True)
            if value:
                return value
    for anchor in article.select("a[href]"):
        href = anchor.get("href", "")
        value = anchor.get_text(" ", strip=True)
        if value and ("profile.php" in href or ("facebook.com/" in href and not any(marker in href for marker in POST_HREF_MARKERS))):
            return value
    return ""


def _text(article: Tag) -> str:
    candidates: list[str] = []
    for selector in TEXT_SELECTORS:
        for element in article.select(selector):
            if not is_in_nested_article(element, article):
                value = element.get_text(" ", strip=True)
                if value:
                    candidates.append(value)
    return max(candidates, key=len, default="")


def _media(article: Tag, base_url: str) -> list[str]:
    urls: set[str] = set()
    for element in article.select("video[src], video source[src], img[src]"):
        if is_in_nested_article(element, article):
            continue
        src = element.get("src", "").strip()
        if src and not any(word in src.lower() for word in ("profile", "avatar")):
            urls.add(absolute(src, base_url))
    for anchor in article.select("a[href]"):
        href = anchor.get("href", "")
        if not is_in_nested_article(anchor, article) and any(marker in href for marker in ("/watch/", "/videos/", "/reel/", "photo.php", "/photo/")):
            urls.add(absolute(href, base_url))
    return sorted(urls)[:20]


def _engagement(article: Tag) -> dict[str, str]:
    patterns = {
        "reactions": r"([\d,.KMB tys.]+)\s*(?:reactions?|likes?|reakcj[ea]|polubie[nń])",
        "comments": r"([\d,.KMB tys.]+)\s*(?:comments?|komentarz\w*)",
        "shares": r"([\d,.KMB tys.]+)\s*(?:shares?|udostępnie[nń])",
        "views": r"([\d,.KMB tys.]+)\s*(?:views?|wyświetle[nń])",
    }
    visible = " ".join([node.get("aria-label", "") for node in article.select("[aria-label]")]
                       + [node.get_text(" ", strip=True) for node in article.select("span")]).casefold()
    values: dict[str, str] = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, visible, flags=re.I)
        if match:
            values[key] = re.sub(r"\s+", " ", match.group(1)).strip()[:40]
    return values


def _roots(soup: BeautifulSoup) -> list[Tag]:
    for selector in POST_SELECTORS:
        candidates = [node for node in soup.select(selector) if not is_nested_article(node)]
        if candidates:
            result: list[Tag] = []
            seen: set[int] = set()
            for node in candidates:
                if id(node) not in seen:
                    result.append(node)
                    seen.add(id(node))
            return result
    return []


def parse_posts(html: str, base_url: str) -> list[Post]:
    soup = BeautifulSoup(html, "html.parser")
    posts: list[Post] = []
    seen: set[str] = set()
    for article in _roots(soup):
        url = _post_url(article, base_url)
        if not url or url in seen:
            continue
        seen.add(url)
        header = _post_header(article)
        posts.append(Post(
            url=url, author=_author(article), published_at=_published_at(article), text=_text(article),
            media=_media(article, base_url), engagement=_engagement(article),
            is_pinned=bool(PINNED_HEADER.search(header)),
            is_repost=bool(REPOST_HEADER.search(header)),
        ))
    return posts


def has_post_markup(html: str) -> bool:
    return bool(_roots(BeautifulSoup(html, "html.parser")))


def is_login_wall(url: str, html: str) -> bool:
    lowered_url = url.lower()
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True).lower()
    wall = any(term in text for term in (
        "log in to facebook", "zaloguj się na facebooku", "zaloguj się, aby kontynuować",
        "potwierdź swoją tożsamość", "sprawdź powiadomienia na innym urządzeniu",
    ))
    return any(term in lowered_url for term in ("/login", "/checkpoint/", "checkpoint/block")) or (
        not has_post_markup(html) and (wall or bool(soup.select_one('input[name="email"], input[name="pass"], [data-testid="royal_login_button"]')))
    )
