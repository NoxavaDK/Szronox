from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT

LOG = logging.getLogger(__name__)


class MonitorApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, retryable: bool) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


class MonitorApi:
    def __init__(self) -> None:
        base = os.getenv("SZRONOX_URL", "").strip().rstrip("/")
        key = os.getenv("SZRONOX_MONITOR_KEY", "").strip()
        if not base or not key:
            raise RuntimeError("Set SZRONOX_URL and SZRONOX_MONITOR_KEY in the Git-ignored .env file")
        self.base_url = base if base.endswith("/api/v1") else base + "/api/v1"
        self.key = key
        self.outbox = PROJECT_ROOT / "outbox" / "requests.json"

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=raw,
            method=method,
            headers={"Authorization": f"Bearer {self.key}", "Accept": "application/json",
                     **({"Content-Type": "application/json; charset=utf-8"} if raw is not None else {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status == 204 or not response.readable():
                    return None
                payload = response.read()
                return json.loads(payload.decode("utf-8")) if payload else None
        except urllib.error.HTTPError as exc:
            detail = exc.read(500).decode("utf-8", errors="replace")
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            raise MonitorApiError(
                f"SzroNox API returned HTTP {exc.code}: {detail}", status_code=exc.code, retryable=retryable
            ) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            raise MonitorApiError(f"SzroNox API request failed: {exc}", retryable=True) from exc

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        return self.request("POST", path, body)

    def enqueue(self, path: str, body: dict[str, Any]) -> None:
        self.outbox.parent.mkdir(parents=True, exist_ok=True)
        entries = self._read_outbox()
        entries.append({"path": path, "body": body})
        self._write_outbox(entries)
        LOG.warning("Queued unsent API request for retry: %s", path)

    def _read_outbox(self) -> list[dict[str, Any]]:
        if not self.outbox.exists():
            return []
        try:
            data = json.loads(self.outbox.read_text(encoding="utf-8"))
            if isinstance(data, list) and all(isinstance(row, dict) for row in data):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        raise RuntimeError(f"Outbox is unreadable; inspect {self.outbox}")

    def _write_outbox(self, entries: list[dict[str, Any]]) -> None:
        self.outbox.parent.mkdir(parents=True, exist_ok=True)
        temp = self.outbox.with_suffix(".tmp")
        temp.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.outbox)

    def replay_outbox(self) -> None:
        entries = self._read_outbox()
        if not entries:
            return
        LOG.info("Retrying %d queued API requests before collection", len(entries))
        remaining = entries[:]
        for index, row in enumerate(entries):
            path, body = row.get("path"), row.get("body")
            if not isinstance(path, str) or not path.startswith("/monitor/collect/") or not isinstance(body, dict):
                raise RuntimeError(f"Outbox contains an invalid request at position {index}")
            try:
                self.post(path, body)
            except MonitorApiError as exc:
                if exc.retryable:
                    self._write_outbox(remaining)
                    raise
                LOG.error("Dropping rejected queued API request (%s): %s", path, exc)
            except Exception:
                self._write_outbox(remaining)
                raise
            remaining.pop(0)
            self._write_outbox(remaining)
        LOG.info("Outbox is clear")

    def post_or_queue(self, path: str, body: dict[str, Any]) -> Any | None:
        # Preserve causal order: a run cannot be finished ahead of one of its queued batches.
        if self._read_outbox():
            self.enqueue(path, body)
            return None
        try:
            return self.post(path, body)
        except MonitorApiError as exc:
            if exc.retryable:
                self.enqueue(path, body)
            else:
                LOG.error("Dropping rejected API request (%s): %s", path, exc)
            return None
