from __future__ import annotations

import re
from urllib.parse import parse_qs, urlencode, urlsplit

FB_HOSTS = {"facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"}
X_HOSTS = {"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"}
FB_POST_PATH = re.compile(r"/(?:posts|videos|reel)/[a-z0-9._-]+(?:/|$)", re.I)
X_STATUS_PATH = re.compile(r"^/([a-z0-9_]+)/status/(\d+)(?:/.*)?$", re.I)


def canonical_post_url(value: object, platform: str) -> tuple[str | None, str | None]:
    if not isinstance(value, str) or len(value) > 2048:
        return None, "not_a_post"
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        if parsed.scheme.lower() not in {"http", "https"} or parsed.username or parsed.password:
            return None, "not_a_post"
    except ValueError:
        return None, "not_a_post"
    path = parsed.path.rstrip("/") or "/"
    if platform == "facebook":
        if host not in FB_HOSTS:
            return None, "not_a_post"
        query = parse_qs(parsed.query, keep_blank_values=True)
        if "comment_id" in query or "reply_comment_id" in query:
            return None, "comment"
        suffix = ""
        if re.search(r"/(?:permalink|story)\.php$", path, re.I):
            kept = [(key, query[key][0]) for key in ("story_fbid", "id") if query.get(key)]
            if not kept:
                return None, "not_a_post"
            suffix = "?" + urlencode(kept)
        elif re.fullmatch(r"/photo(?:\.php)?", path, re.I):
            fbid = query.get("fbid", [""])[0]
            if not fbid:
                return None, "not_a_post"
            suffix = "?" + urlencode([("fbid", fbid)])
        elif re.fullmatch(r"/watch", path, re.I):
            video = query.get("v", [""])[0]
            if not video:
                return None, "not_a_post"
            suffix = "?" + urlencode([("v", video)])
        elif not FB_POST_PATH.search(path + "/"):
            return None, "not_a_post"
        return "https://www.facebook.com" + path + suffix, None
    if platform == "x":
        if host not in X_HOSTS:
            return None, "not_a_post"
        match = X_STATUS_PATH.fullmatch(path)
        if not match:
            return None, "not_a_post"
        return f"https://x.com/{match.group(1)}/status/{match.group(2)}", None
    return None, "not_a_post"
