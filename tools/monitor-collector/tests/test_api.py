from __future__ import annotations

import json
import logging
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from monitor_collector.api import MonitorApi, MonitorApiError


@pytest.fixture
def api_client(monkeypatch):
    monkeypatch.setenv("SZRONOX_URL", "https://monitor.example")
    monkeypatch.setenv("SZRONOX_MONITOR_KEY", "test-key")
    with TemporaryDirectory(prefix=".test-outbox-", dir=Path(__file__).resolve().parents[1]) as temporary:
        api = MonitorApi()
        api.outbox = Path(temporary) / "requests.json"
        yield api


@pytest.mark.parametrize("failure", [
    MonitorApiError("HTTP 429", status_code=429, retryable=True),
    MonitorApiError("HTTP 503", status_code=503, retryable=True),
    MonitorApiError("connection reset", retryable=True),
])
def test_post_or_queue_queues_only_retryable_api_failures(api_client, monkeypatch, failure) -> None:
    api = api_client
    monkeypatch.setattr(api, "post", lambda _path, _body: (_ for _ in ()).throw(failure))

    assert api.post_or_queue("/monitor/collect/posts", {"batch": 1}) is None
    assert api._read_outbox() == [{"path": "/monitor/collect/posts", "body": {"batch": 1}}]


def test_post_or_queue_logs_and_drops_nonretryable_4xx(api_client, monkeypatch, caplog) -> None:
    api = api_client
    failure = MonitorApiError("SzroNox API returned HTTP 422: invalid post", status_code=422, retryable=False)
    monkeypatch.setattr(api, "post", lambda _path, _body: (_ for _ in ()).throw(failure))

    with caplog.at_level(logging.ERROR, logger="monitor_collector.api"):
        assert api.post_or_queue("/monitor/collect/posts", {"batch": 1}) is None

    assert api._read_outbox() == []
    assert "HTTP 422" in caplog.text
    assert "/monitor/collect/posts" in caplog.text


def test_replay_outbox_drops_4xx_and_continues_to_later_requests(api_client, monkeypatch, caplog) -> None:
    api = api_client
    queued = [
        {"path": "/monitor/collect/posts", "body": {"batch": "rejected"}},
        {"path": "/monitor/collect/runs/run-1/finish", "body": {"status": "ok"}},
    ]
    api._write_outbox(queued)
    calls: list[str] = []

    def post(path, _body):
        calls.append(path)
        if len(calls) == 1:
            raise MonitorApiError("SzroNox API returned HTTP 422: invalid post", status_code=422, retryable=False)

    monkeypatch.setattr(api, "post", post)
    with caplog.at_level(logging.ERROR, logger="monitor_collector.api"):
        api.replay_outbox()

    assert calls == [row["path"] for row in queued]
    assert api._read_outbox() == []
    assert "HTTP 422" in caplog.text


def test_replay_outbox_preserves_queue_when_a_request_is_retryable(api_client, monkeypatch) -> None:
    api = api_client
    queued = [{"path": "/monitor/collect/posts", "body": {"batch": 1}}]
    api._write_outbox(queued)
    monkeypatch.setattr(api, "post", lambda _path, _body: (_ for _ in ()).throw(
        MonitorApiError("HTTP 503", status_code=503, retryable=True)
    ))

    with pytest.raises(MonitorApiError):
        api.replay_outbox()

    assert json.loads(api.outbox.read_text(encoding="utf-8")) == queued
