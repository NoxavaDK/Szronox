from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Source:
    id: str
    platform: str
    profile_url: str
    known_urls: frozenset[str] = frozenset()


@dataclass
class Post:
    url: str
    author: str = ""
    published_at: str | None = None
    text: str = ""
    media: list[str] = field(default_factory=list)
    engagement: dict[str, str] = field(default_factory=dict)
    is_repost: bool = False
    is_pinned: bool = False
