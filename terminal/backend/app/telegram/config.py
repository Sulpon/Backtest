"""
Telegram bot configuration, read from the environment - see
terminal/backend/.env.example. Deliberately plain os.environ.get(), same as
main.py's CORS_ALLOWED_ORIGINS, not python-dotenv's load_dotenv(): this
module must stay importable with zero extra dependencies so it can never be
the thing that breaks the production (Vercel) import of main.py, which
loads .env itself (guarded) before this is ever read - see main.py's own
top-of-file comment.

Unlike MarketDataProvider's config (which raises when misconfigured,
because the app can't function without market data), a missing Telegram
config is a normal, expected state - the trade-review feature is optional
and local-only for now, so get_telegram_config() returns None rather than
raising, and every call site is expected to handle that gracefully.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class TelegramConfig:
    bot_token: str
    chat_id: str


def get_telegram_config() -> Optional[TelegramConfig]:
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not bot_token or not chat_id:
        return None
    return TelegramConfig(bot_token=bot_token, chat_id=chat_id)
