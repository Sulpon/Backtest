"""
/api/telegram/* route wiring. These routes never touch data.duckdb, so
unlike test_service.py's temp-DB fixture, no database setup is needed here
- just the app importing cleanly and the routes calling TelegramService
correctly. TelegramService itself is exercised in test_telegram_service.py;
this file only checks the routes never surface a 500.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.telegram import service as telegram_service_module


@pytest.fixture
def client():
    return TestClient(app)


def test_status_reports_not_configured_when_env_unset(client, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    res = client.get("/api/telegram/status")
    assert res.status_code == 200
    assert res.json() == {"configured": False}


def test_status_reports_configured_when_env_set(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:FAKE")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    res = client.get("/api/telegram/status")
    assert res.status_code == 200
    assert res.json() == {"configured": True}


def test_test_endpoint_returns_ok_false_never_500_when_unconfigured(client, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    res = client.post("/api/telegram/test")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "not configured" in body["error"]


def test_test_endpoint_success_path(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:FAKE")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    monkeypatch.setattr(
        telegram_service_module.TelegramService,
        "_call_api",
        lambda self, method, payload: {"ok": True, "result": {"message_id": 1}},
    )
    res = client.post("/api/telegram/test")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "error": None}


SAMPLE_TRADE_PAYLOAD = {
    "tradeId": "EURUSD:1200",
    "symbol": "EURUSD",
    "timeframe": "1H",
    "direction": "LONG",
    "setup": "A",
    "entry": 1.08345,
    "sl": 1.0793,
    "tp": 1.0929,
    "rr": 2.27,
    "resultR": 2.45,
    "closedAt": "17 May 2025 15:00 UTC",
    "conditions": {"liquiditySweep": True, "bos": True, "choch": False, "fvg": True},
}


def test_send_trade_endpoint_success_path(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:FAKE")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    sent = {}

    def fake_call_api(self, method, payload):
        sent["method"] = method
        sent["payload"] = payload
        return {"ok": True, "result": {"message_id": 7}}

    monkeypatch.setattr(telegram_service_module.TelegramService, "_call_api", fake_call_api)
    res = client.post("/api/telegram/send-trade", json=SAMPLE_TRADE_PAYLOAD)

    assert res.status_code == 200
    assert res.json() == {"ok": True, "error": None}
    assert sent["method"] == "sendMessage"
    assert "EURUSD:1200" in sent["payload"]["text"]


def test_send_trade_endpoint_rejects_invalid_direction(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:FAKE")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    bad_payload = {**SAMPLE_TRADE_PAYLOAD, "direction": "SIDEWAYS"}
    res = client.post("/api/telegram/send-trade", json=bad_payload)
    assert res.status_code == 422  # FastAPI's own request validation, never reaches TelegramService


def test_send_trade_endpoint_never_500_when_unconfigured(client, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    res = client.post("/api/telegram/send-trade", json=SAMPLE_TRADE_PAYLOAD)
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "not configured" in body["error"]


# 1x1 red pixel PNG, base64-encoded - a real (tiny) PNG so decoding is
# exercised against genuine image bytes, not an arbitrary placeholder.
TINY_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+"
    "M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_send_trade_endpoint_with_snapshot_uses_send_photo(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:FAKE")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    sent = {}

    def fake_call_api(self, method, payload, files=None):
        sent["method"] = method
        sent["payload"] = payload
        sent["files"] = files
        return {"ok": True, "result": {"message_id": 7}}

    monkeypatch.setattr(telegram_service_module.TelegramService, "_call_api", fake_call_api)
    payload = {**SAMPLE_TRADE_PAYLOAD, "snapshotDataUrl": f"data:image/png;base64,{TINY_PNG_BASE64}"}
    res = client.post("/api/telegram/send-trade", json=payload)

    assert res.status_code == 200
    assert res.json() == {"ok": True, "error": None}
    assert sent["method"] == "sendPhoto"
    assert sent["files"]["photo"][2] == "image/png"
    assert len(sent["files"]["photo"][1]) > 0  # real decoded bytes, not empty


def test_send_trade_endpoint_with_malformed_snapshot_falls_back_to_text(client, monkeypatch):
    """A corrupt snapshotDataUrl must degrade to the text-only send, never
    reject the whole request - the chart snapshot is a nice-to-have on top
    of the review itself, not a precondition for sending it."""
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:FAKE")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    sent = {}

    def fake_call_api(self, method, payload):
        sent["method"] = method
        return {"ok": True, "result": {"message_id": 7}}

    monkeypatch.setattr(telegram_service_module.TelegramService, "_call_api", fake_call_api)
    payload = {**SAMPLE_TRADE_PAYLOAD, "snapshotDataUrl": "data:image/png;base64,not-valid-base64!!!"}
    res = client.post("/api/telegram/send-trade", json=payload)

    assert res.status_code == 200
    assert res.json() == {"ok": True, "error": None}
    assert sent["method"] == "sendMessage"
