"""
Every candle batch is classified VALID / WARNING / INVALID before it's
allowed into the database. "Do NOT automatically fix suspicious market data
silently" means this module only ever reports - it never mutates a candle
to make it pass.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from .models import Candle

# A forex weekend gap (Friday close to Sunday open) is expected and is not
# itself a warning; anything longer than this could be a real provider
# outage or a missing chunk and gets flagged. 50h gives comfortable margin
# on both sides of the actual ~48h weekend closure.
EXPECTED_WEEKEND_GAP_SECONDS = 60 * 60 * 50

# Sanity ceiling for "impossible timestamp" - year 2100, unix seconds.
_MAX_PLAUSIBLE_TIMESTAMP = 4_102_444_800


class ValidationLevel(str, Enum):
    VALID = "valid"
    WARNING = "warning"
    INVALID = "invalid"


@dataclass
class ValidationIssue:
    level: ValidationLevel
    code: str
    message: str
    timestamp_utc: Optional[int] = None


@dataclass
class ValidationResult:
    level: ValidationLevel
    issues: list[ValidationIssue] = field(default_factory=list)


def validate_candles(candles: list[Candle], timeframe_seconds: Optional[int]) -> ValidationResult:
    """`timeframe_seconds` is the expected spacing between consecutive
    candles (None for "1mo", which has no fixed spacing and so skips the
    gap check). Assumes `candles` is already sorted ascending by
    timestamp - callers control that, this only reports on what it's given."""
    issues: list[ValidationIssue] = []
    seen_timestamps: set[int] = set()
    prev: Optional[Candle] = None

    for c in candles:
        if c.timestamp_utc in seen_timestamps:
            issues.append(
                ValidationIssue(ValidationLevel.INVALID, "duplicate_timestamp",
                                 f"Duplicate candle at {c.timestamp_utc}", c.timestamp_utc)
            )
        seen_timestamps.add(c.timestamp_utc)

        if c.high < c.low:
            issues.append(
                ValidationIssue(ValidationLevel.INVALID, "high_below_low",
                                 f"high {c.high} < low {c.low}", c.timestamp_utc)
            )
        if not (c.low <= c.open <= c.high):
            issues.append(
                ValidationIssue(ValidationLevel.INVALID, "open_outside_range",
                                 f"open {c.open} outside [{c.low}, {c.high}]", c.timestamp_utc)
            )
        if not (c.low <= c.close <= c.high):
            issues.append(
                ValidationIssue(ValidationLevel.INVALID, "close_outside_range",
                                 f"close {c.close} outside [{c.low}, {c.high}]", c.timestamp_utc)
            )
        if c.timestamp_utc < 0 or c.timestamp_utc > _MAX_PLAUSIBLE_TIMESTAMP:
            issues.append(
                ValidationIssue(ValidationLevel.INVALID, "impossible_timestamp",
                                 f"timestamp {c.timestamp_utc} is outside a plausible range", c.timestamp_utc)
            )

        if prev is not None:
            if c.timestamp_utc <= prev.timestamp_utc:
                issues.append(
                    ValidationIssue(ValidationLevel.INVALID, "non_monotonic",
                                     f"{c.timestamp_utc} does not follow {prev.timestamp_utc}", c.timestamp_utc)
                )
            elif timeframe_seconds:
                gap = c.timestamp_utc - prev.timestamp_utc
                if gap > timeframe_seconds and gap > EXPECTED_WEEKEND_GAP_SECONDS:
                    issues.append(
                        ValidationIssue(
                            ValidationLevel.WARNING, "unexpected_gap",
                            f"{gap}s gap after {prev.timestamp_utc} (expected {timeframe_seconds}s)",
                            c.timestamp_utc,
                        )
                    )
        prev = c

    if any(i.level == ValidationLevel.INVALID for i in issues):
        level = ValidationLevel.INVALID
    elif any(i.level == ValidationLevel.WARNING for i in issues):
        level = ValidationLevel.WARNING
    else:
        level = ValidationLevel.VALID
    return ValidationResult(level=level, issues=issues)
