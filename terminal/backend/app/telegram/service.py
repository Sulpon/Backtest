"""
Thin wrapper around the Telegram Bot API (https://core.telegram.org/bots/api).

Every public method fails soft - returns a TelegramResult, never raises -
because a Telegram outage must never take down anything else in this app
(the trade-review feature's own hard requirement). main.py's /api/telegram/*
routes surface TelegramResult.error as a normal 200 response, never a 500.

httpx is a requirements-dev.txt-only dependency (see that file's own
comment: this whole feature is local/self-hosted only for now, not part of
the production Vercel bundle). Importing it happens lazily inside
_call_api(), not at module load time, so `import app.telegram.service`
itself can never fail even where httpx isn't installed - only actually
calling the Telegram API does, and that failure is caught and turned into
an ordinary TelegramResult(ok=False, ...) like any other.

Extension points for later milestones (not yet implemented - see
terminal/README.md#telegram-trade-review for the milestone plan):
  - answerTradeReview(...): answerCallbackQuery after a button press
  - editTradeReviewMessage(...): editMessageReplyMarkup once answered
Each is just another _post()/_post_multipart() call with a different
Telegram method/payload - this class's shape doesn't need to change to add
them.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional

from .config import TelegramConfig, get_telegram_config

TELEGRAM_API_BASE = "https://api.telegram.org"

# Maps a TradeReviewRequest.conditions key (see main.py) to its display
# label in the message - the single place that needs editing to add a new
# detectable condition (matches the original spec's "should be configurable
# rather than hardcoded deep inside the Telegram service" for review
# reasons; conditions are the analogous case for the message itself).
CONDITION_LABELS: dict[str, str] = {
    "liquiditySweep": "Liquidity Sweep",
    "bos": "BOS",
    "choch": "CHoCH",
    "fvg": "FVG",
}


def format_trade_review_message(trade: dict[str, Any]) -> str:
    """Pure function (no network) - kept separate from send_trade_review so
    the exact text can be unit-tested without touching TelegramService at
    all. `trade` is a plain dict (from TradeReviewRequest.model_dump()) so
    this has no FastAPI/Pydantic dependency of its own."""
    lines = [
        "\U0001f4cb TRADE REVIEW",
        "",
        f"ID: {trade['tradeId']}",
        f"Symbol: {trade['symbol']}",
        f"Timeframe: {trade['timeframe']}",
        f"Direction: {trade['direction']}",
        "",
        f"Setup: {trade['setup']}",
        "",
        f"Entry: {trade['entry']}",
        f"SL: {trade['sl']}",
        f"TP: {trade['tp']}",
        "",
        f"RR: {trade['rr']:.2f}R",
        f"Result: {trade['resultR']:+.2f}R",
        "",
        f"Closed: {trade['closedAt']}",
    ]
    conditions = trade.get("conditions") or {}
    detected = [label for key, label in CONDITION_LABELS.items() if conditions.get(key)]
    if detected:
        lines.append("")
        lines.append("Detected conditions:")
        lines.extend(f"✓ {label}" for label in detected)
    return "\n".join(lines)


# Callback data must be short (Telegram enforces a 64-byte limit) and
# parseable by the future webhook handler (Milestone 5) - "trade_review:
# <tradeId>:<action>" matches the format the original spec calls for.
# tradeId is symbol:entryBar (see tradeReviewPayload.ts) - comfortably
# under the limit even for a 6-digit bar index.
def build_review_keyboard(trade_id: str) -> dict[str, Any]:
    return {
        "inline_keyboard": [
            [
                {"text": "✅ YES, it follows", "callback_data": f"trade_review:{trade_id}:yes"},
                {"text": "❌ NO, it doesn't", "callback_data": f"trade_review:{trade_id}:no"},
                {"text": "🤔 PARTIALLY", "callback_data": f"trade_review:{trade_id}:partial"},
            ]
        ]
    }


@dataclass
class TelegramResult:
    ok: bool
    error: Optional[str] = None
    # Telegram's own message_id for the sent message - needed by later
    # milestones (editing the message after a review button is pressed).
    # None whenever ok is False.
    message_id: Optional[int] = None


class TelegramService:
    def __init__(self, config: Optional[TelegramConfig] = None):
        # Explicit config (tests) bypasses environment lookup entirely;
        # omitted (normal call sites) reads it fresh from the environment
        # on every construction - cheap, and means a config change takes
        # effect without restarting the process.
        self.config = config if config is not None else get_telegram_config()

    @property
    def configured(self) -> bool:
        return self.config is not None

    def _call_api(
        self, method: str, payload: dict[str, Any], files: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        """The one place that actually talks to Telegram - isolated so
        tests can monkeypatch just this method instead of mocking
        httpx/network (same pattern as MockProvider in test_service.py).
        `files` (only set for sendPhoto) forces a multipart/form-data POST
        instead of JSON - Telegram's file-upload endpoints require it.

        Deliberately does NOT call resp.raise_for_status(): Telegram
        returns a real JSON body - {"ok": false, "description": "..."} -
        on 4xx responses too (e.g. "Bad Request: chat not found"), which is
        exactly the actionable detail _parse_result()'s
        `data.get("description")` surfaces. raise_for_status() would throw
        before that body is ever read, collapsing every 4xx into an opaque
        generic HTTP error."""
        import httpx  # deferred - see module docstring

        assert self.config is not None
        url = f"{TELEGRAM_API_BASE}/bot{self.config.bot_token}/{method}"
        if files is not None:
            resp = httpx.post(url, data=payload, files=files, timeout=30.0)
        else:
            resp = httpx.post(url, json=payload, timeout=10.0)
        return resp.json()

    def _parse_result(self, data: dict[str, Any]) -> TelegramResult:
        if not data.get("ok"):
            return TelegramResult(ok=False, error=data.get("description", "Telegram API returned ok=false"))
        result = data.get("result") or {}
        return TelegramResult(ok=True, message_id=result.get("message_id"))

    def _post(self, method: str, payload: dict[str, Any], files: Optional[dict[str, Any]] = None) -> TelegramResult:
        if self.config is None:
            return TelegramResult(ok=False, error="Telegram is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)")
        try:
            # Only passes files= when actually set (rather than always
            # passing files=None) so a test double for _call_api written
            # against the pre-Milestone-4 2-argument signature - see
            # test_telegram_service.py - keeps working unchanged for every
            # non-photo call path.
            data = self._call_api(method, payload, files=files) if files is not None else self._call_api(method, payload)
        except ImportError:
            return TelegramResult(ok=False, error="httpx is not installed - run `pip install -r requirements-dev.txt`")
        except Exception as e:  # noqa: BLE001 - any failure here must degrade to TelegramResult, never raise
            return TelegramResult(ok=False, error=f"Telegram request failed: {e}")
        return self._parse_result(data)

    def send_message(self, text: str) -> TelegramResult:
        if self.config is None:
            return TelegramResult(ok=False, error="Telegram is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)")
        return self._post("sendMessage", {"chat_id": self.config.chat_id, "text": text})

    def send_trade_review(self, trade: dict[str, Any], image_bytes: Optional[bytes] = None) -> TelegramResult:
        """Milestone 2 sent plain text only (sendMessage). Milestone 4 adds
        an optional chart snapshot: when image_bytes is provided, this
        sends a photo (sendPhoto) with the same formatted text as its
        caption plus YES/NO/PARTIALLY inline buttons instead. Falls back to
        the plain-text path when no image is available (e.g. no matching
        chart pane was open to capture from - see chartRegistry.ts) so a
        missing snapshot never blocks sending the review itself."""
        if self.config is None:
            return TelegramResult(ok=False, error="Telegram is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)")
        text = format_trade_review_message(trade)
        if image_bytes is None:
            return self._post("sendMessage", {"chat_id": self.config.chat_id, "text": text})
        keyboard = build_review_keyboard(trade["tradeId"])
        return self._post(
            "sendPhoto",
            {"chat_id": self.config.chat_id, "caption": text, "reply_markup": json.dumps(keyboard)},
            files={"photo": ("snapshot.png", image_bytes, "image/png")},
        )
