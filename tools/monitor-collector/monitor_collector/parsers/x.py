from __future__ import annotations

import re

from bs4 import BeautifulSoup, Tag

from ..canonical_url import canonical_post_url
from ..models import Post
from .common import absolute, is_in_nested_article, is_nested_article, parse_timestamp, visible_label_text

# Keep X-specific selectors here; markup changes frequently.
POST_SELECTORS = ('article[data-testid="tweet"]',)
TEXT_SELECTORS = ('[data-testid="tweetText"]',)
AUTHOR_SELECTORS = ('[data-testid="User-Name"]',)
POST_HREF_SELECTOR = 'a[href*="/status/"]'
ENGAGEMENT_SELECTORS = {
    "replies": ('[data-testid="reply"]',),
    "reposts": ('[data-testid="retweet"]', '[data-testid="unretweet"]'),
    "likes": ('[data-testid="like"]', '[data-testid="unlike"]'),
    "views": ('[data-testid="viewCount"]',),
}


def _post_url(article: Tag, base_url: str) -> str:
    for anchor in article.select(POST_HREF_SELECTOR):
        if is_in_nested_article(anchor, article):
            continue
        url, reason = canonical_post_url(absolute(anchor.get("href", ""), base_url), "x")
        if url and reason is None:
            return url
    return ""


def _engagement(article: Tag) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, selectors in ENGAGEMENT_SELECTORS.items():
        for selector in selectors:
            node = article.select_one(selector)
            if not node:
                continue
            value = node.get("aria-label", "") or node.get_text(" ", strip=True)
            if value:
                match = re.search(r"[\d,.KMB]+", value, flags=re.I)
                if match:
                    result[key] = match.group(0)[:40]
                break
    return result


def _roots(soup: BeautifulSoup) -> list[Tag]:
    return [node for node in soup.select(POST_SELECTORS[0]) if not is_nested_article(node)]


def parse_posts(html: str, base_url: str) -> list[Post]:
    soup = BeautifulSoup(html, "html.parser")
    posts: list[Post] = []
    seen: set[str] = set()
    for article in _roots(soup):
        url = _post_url(article, base_url)
        if not url or url in seen:
            continue
        seen.add(url)
        author_node = article.select_one(AUTHOR_SELECTORS[0])
        text_node = next((node for node in article.select(TEXT_SELECTORS[0]) if not is_in_nested_article(node, article)), None)
        time_node = next((node for node in article.select("time[datetime]") if not is_in_nested_article(node, article)), None)
        media: set[str] = set()
        for element in article.select("img[src], video[src], video source[src]"):
            if is_in_nested_article(element, article):
                continue
            src = element.get("src", "").strip()
            if src and not (element.name == "img" and "profile_images" in src):
                media.add(absolute(src, base_url))
        for anchor in article.select('a[href*="/photo/"]'):
            if not is_in_nested_article(anchor, article):
                media.add(absolute(anchor.get("href", ""), base_url))
        context = visible_label_text(article)
        posts.append(Post(
            url=url,
            author=author_node.get_text(" ", strip=True) if author_node else "",
            published_at=parse_timestamp(time_node.get("datetime") if time_node else None),
            text=text_node.get_text(" ", strip=True) if text_node else "",
            media=sorted(media)[:20], engagement=_engagement(article),
            is_pinned=any(token in context for token in ("pinned", "przypięt", "przypiety")),
            is_repost=any(token in context for token in (
                "retweeted", "reposted", "podał dalej", "podała dalej", "udostępnił", "udostępniła",
            )),
        ))
    return posts


def has_post_markup(html: str) -> bool:
    return bool(_roots(BeautifulSoup(html, "html.parser")))


def is_login_wall(url: str, html: str) -> bool:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True).lower()
    lowered_url = url.lower()
    wall = any(term in text for term in (
        "log in to x", "sign up for x", "to view this profile", "zaloguj się do x",
        "zarejestruj się w x", "zaloguj się, aby zobaczyć ten profil",
    ))
    return any(term in lowered_url for term in ("/login", "/i/flow/login", "/account/access")) or (
        not has_post_markup(html) and (wall or bool(soup.select_one('[data-testid="LoginForm_Login_Button"], a[href*="/i/flow/login"]')))
    )
