from pathlib import Path

from monitor_collector.canonical_url import canonical_post_url
from monitor_collector.parsers import facebook, x

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_facebook_saved_profile_extracts_post_content_and_media() -> None:
    posts = facebook.parse_posts(fixture("facebook_profile.html"), "https://www.facebook.com/Konfederacja")
    assert len(posts) == 1
    post = posts[0]
    assert post.url == "https://www.facebook.com/jan.kowalski/posts/123456"
    assert post.author == "Jan Kowalski"
    assert "cenach energii" in post.text
    assert post.published_at == "2026-11-04T07:15:00+00:00"
    assert "reactions" in post.engagement
    assert len(post.media) == 2


def test_facebook_pin_repost_and_nested_comment_are_distinguished() -> None:
    posts = facebook.parse_posts(fixture("facebook_review_edges.html"), "https://www.facebook.com/page")
    assert len(posts) == 2
    assert posts[0].is_pinned is True
    assert posts[0].is_repost is False
    assert posts[0].url == "https://www.facebook.com/permalink.php?story_fbid=101&id=1001"
    assert "Komentarz nie jest osobnym postem" not in posts[0].text
    assert posts[1].is_repost is True


def test_x_saved_profile_extracts_status_engagement_and_media() -> None:
    posts = x.parse_posts(fixture("x_profile.html"), "https://x.com/home")
    assert len(posts) == 1
    post = posts[0]
    assert post.url == "https://x.com/annanowak/status/987654321"
    assert post.author.startswith("Anna Nowak")
    assert "podatkach" in post.text
    assert post.engagement["likes"] == "210"
    assert post.media == ["https://pbs.twimg.com/media/post-image.jpg"]


def test_x_review_fixture_flags_pin_and_repost_and_drops_suffixes() -> None:
    posts = x.parse_posts(fixture("x_review_edges.html"), "https://x.com/home")
    assert [post.url for post in posts] == [
        "https://x.com/KontoX/status/111", "https://x.com/InneKonto/status/222",
    ]
    assert posts[0].is_pinned is True
    assert posts[1].is_repost is True


def test_login_walls_cover_polish_and_english_copy() -> None:
    assert facebook.is_login_wall("https://www.facebook.com/login", "<html>Log in</html>")
    assert facebook.is_login_wall("https://www.facebook.com/", "<html>Zaloguj się na Facebooku</html>")
    assert x.is_login_wall("https://x.com/i/flow/login", "<html>Log in to X</html>")
    assert x.is_login_wall("https://x.com/", "<html>Zaloguj się do X</html>")


def test_canonical_urls_match_api_rules() -> None:
    assert canonical_post_url(
        "http://m.facebook.com/permalink.php?__cft__=x&id=3&story_fbid=4&__tn__=y#top", "facebook"
    ) == ("https://www.facebook.com/permalink.php?story_fbid=4&id=3", None)
    assert canonical_post_url("https://web.facebook.com/page/posts/55?__cft__=x", "facebook")[0] == \
        "https://www.facebook.com/page/posts/55"
    assert canonical_post_url("https://facebook.com/post/55", "facebook") == (None, "not_a_post")
    assert canonical_post_url("https://facebook.com/page/posts/55?comment_id=9", "facebook") == (None, "comment")
    assert canonical_post_url("https://mobile.twitter.com/Anna/status/88/photo/1?x=1", "x") == \
        ("https://x.com/Anna/status/88", None)
    assert canonical_post_url("https://x.com/Anna/status/88/analytics", "x")[0] == "https://x.com/Anna/status/88"
    assert canonical_post_url("https://x.com/Anna", "x") == (None, "not_a_post")
