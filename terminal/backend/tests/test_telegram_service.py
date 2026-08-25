"""
TelegramService tested entirely against a monkeypatched _call_api - no
network, no real bot token ("mock the external provider in tests; do not
make tests depend on a live API", same rule as test_service.py's
MockProvider). _call_api is the one seam that actually talks to httpx/the
network, so replacing it is enough to exercise every other code path.
"""
import json
import sys

from app.telegram.config import TelegramConfig
from app.telegram.service import TelegramService, build_review_keyboard, format_trade_review_message


def make_service() -> TelegramService:
    return TelegramService(config=TelegramConfig(bot_token="123:FAKE", chat_id="42"))


SAMPLE_TRADE = {
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


def test_unconfigured_send_message_fails_soft_without_calling_api():
    # config=None is not "force unconfigured" - it's the same value as the
    # constructor's own default, which falls back to a real environment
    # lookup (see TelegramService.__init__). Passing an explicit,
    # already-None TelegramConfig instance is what actually forces
    # "unconfigured" regardless of what's in the environment (e.g. the
    # real backend/.env, which main.py's own load_dotenv() may have
    # already loaded into this process by the time this test runs).
    service = TelegramService(config=None)
    service.config = None
    result = service.send_message("hello")
    assert result.ok is False
    assert "not configured" in result.error
    assert result.message_id is None


def test_configured_property_reflects_config_presence():
    unconfigured = TelegramService(config=None)
    unconfigured.config = None  # see comment above
    assert unconfigured.configured is False
    assert make_service().configured is True


def test_send_message_success_returns_message_id(monkeypatch):
    service = make_service()
    calls = []

    def fake_call_api(self, method, payload):
        calls.append((method, payload))
        return {"ok": True, "result": {"message_id": 555}}

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api)
    result = service.send_message("hello world")

    assert result.ok is True
    assert result.error is None
    assert result.message_id == 555
    assert calls == [("sendMessage", {"chat_id": "42", "text": "hello world"})]


def test_send_message_telegram_api_error_fails_soft(monkeypatch):
    service = make_service()

    def fake_call_api(self, method, payload):
        return {"ok": False, "description": "chat not found"}

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api)
    result = service.send_message("hello")

    assert result.ok is False
    assert result.error == "chat not found"


def test_send_message_network_failure_fails_soft_never_raises(monkeypatch):
    service = make_service()

    def fake_call_api(self, method, payload):
        raise ConnectionError("could not reach api.telegram.org")

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api)
    result = service.send_message("hello")  # must not raise

    assert result.ok is False
    assert "could not reach api.telegram.org" in result.error


def test_send_message_missing_httpx_fails_soft(monkeypatch):
    service = make_service()

    def fake_call_api(self, method, payload):
        raise ImportError("no module named httpx")

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api)
    result = service.send_message("hello")

    assert result.ok is False
    assert "httpx is not installed" in result.error


def test_call_api_surfaces_telegram_description_on_http_4xx(monkeypatch):
    """Regression test: Telegram returns a real JSON body - {"ok": false,
    "description": "..."} - on 4xx responses (e.g. a bad chat_id), which is
    exactly the actionable detail a user needs from "Test Telegram". A
    resp.raise_for_status() call would throw before that body is ever read,
    collapsing it into an opaque generic HTTP error instead - this exercises
    the real _call_api (not a monkeypatched one) against a fake httpx-like
    response to confirm that description survives all the way out."""
    service = make_service()

    class FakeResponse:
        status_code = 400

        def json(self):
            return {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}

    class FakeHttpx:
        @staticmethod
        def post(url, json, timeout):
            return FakeResponse()

    monkeypatch.setitem(sys.modules, "httpx", FakeHttpx())
    result = service.send_message("hello")

    assert result.ok is False
    assert result.error == "Bad Request: chat not found"


def test_format_trade_review_message_includes_all_core_fields():
    text = format_trade_review_message(SAMPLE_TRADE)

    assert "TRADE REVIEW" in text
    assert "ID: EURUSD:1200" in text
    assert "Symbol: EURUSD" in text
    assert "Timeframe: 1H" in text
    assert "Direction: LONG" in text
    assert "Setup: A" in text
    assert "Entry: 1.08345" in text
    assert "SL: 1.0793" in text
    assert "TP: 1.0929" in text
    assert "RR: 2.27R" in text
    assert "Result: +2.45R" in text
    assert "Closed: 17 May 2025 15:00 UTC" in text


def test_format_trade_review_message_only_lists_detected_conditions():
    text = format_trade_review_message(SAMPLE_TRADE)

    assert "Detected conditions:" in text
    assert "✓ Liquidity Sweep" in text
    assert "✓ BOS" in text
    assert "✓ FVG" in text
    assert "CHoCH" not in text  # false in SAMPLE_TRADE - must not be listed as detected


def test_format_trade_review_message_omits_conditions_section_when_none_detected():
    trade = {**SAMPLE_TRADE, "conditions": {"liquiditySweep": False, "bos": False, "choch": False, "fvg": False}}
    text = format_trade_review_message(trade)
    assert "Detected conditions" not in text


def test_format_trade_review_message_negative_result_has_no_plus_sign():
    trade = {**SAMPLE_TRADE, "resultR": -1.0}
    text = format_trade_review_message(trade)
    assert "Result: -1.00R" in text


def test_send_trade_review_success(monkeypatch):
    service = make_service()
    calls = []

    def fake_call_api(self, method, payload):
        calls.append((method, payload))
        return {"ok": True, "result": {"message_id": 42}}

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api)
    result = service.send_trade_review(SAMPLE_TRADE)

    assert result.ok is True
    assert result.message_id == 42
    assert calls[0][0] == "sendMessage"
    assert calls[0][1]["chat_id"] == "42"
    assert "EURUSD:1200" in calls[0][1]["text"]


def test_send_trade_review_unconfigured_fails_soft():
    service = TelegramService(config=None)
    service.config = None
    result = service.send_trade_review(SAMPLE_TRADE)
    assert result.ok is False
    assert "not configured" in result.error


def test_build_review_keyboard_shape_and_callback_data():
    keyboard = build_review_keyboard("EURUSD:1200")
    buttons = keyboard["inline_keyboard"][0]
    assert [b["callback_data"] for b in buttons] == [
        "trade_review:EURUSD:1200:yes",
        "trade_review:EURUSD:1200:no",
        "trade_review:EURUSD:1200:partial",
    ]
    assert [b["text"] for b in buttons] == ["✅ YES, it follows", "❌ NO, it doesn't", "🤔 PARTIALLY"]
    # Telegram enforces a hard 64-byte limit on callback_data.
    for b in buttons:
        assert len(b["callback_data"].encode("utf-8")) <= 64


def test_send_trade_review_with_image_uses_send_photo_with_caption_and_buttons(monkeypatch):
    service = make_service()
    calls = []

    def fake_call_api(self, method, payload, files=None):
        calls.append((method, payload, files))
        return {"ok": True, "result": {"message_id": 99}}

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api)
    result = service.send_trade_review(SAMPLE_TRADE, image_bytes=b"\x89PNG-fake-bytes")

    assert result.ok is True
    assert result.message_id == 99
    method, payload, files = calls[0]
    assert method == "sendPhoto"
    assert payload["chat_id"] == "42"
    assert "EURUSD:1200" in payload["caption"]
    keyboard = json.loads(payload["reply_markup"])
    assert keyboard == build_review_keyboard("EURUSD:1200")
    assert files == {"photo": ("snapshot.png", b"\x89PNG-fake-bytes", "image/png")}


def test_send_trade_review_without_image_never_passes_files_kwarg(monkeypatch):
    """Regression test for the _post() backward-compat branch: a caller
    (e.g. Milestone 2's plain-text path) that never provides image_bytes
    must still work against a _call_api mock written before Milestone 4
    added the files parameter."""
    service = make_service()
    calls = []

    def fake_call_api_old_signature(self, method, payload):
        calls.append((method, payload))
        return {"ok": True, "result": {"message_id": 1}}

    monkeypatch.setattr(TelegramService, "_call_api", fake_call_api_old_signature)
    result = service.send_trade_review(SAMPLE_TRADE)  # no image_bytes - must not raise TypeError

    assert result.ok is True
    assert calls[0][0] == "sendMessage"


def test_send_trade_review_with_image_unconfigured_fails_soft_without_upload():
    service = TelegramService(config=None)
    service.config = None
    result = service.send_trade_review(SAMPLE_TRADE, image_bytes=b"fake")
    assert result.ok is False
    assert "not configured" in result.error
