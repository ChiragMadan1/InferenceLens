"""compute_cost turns raw token counts into stored cost_usd. A wrong rate
or a swallowed edge case would silently mis-bill every log going forward
(PRICE_MAP_VERSION is not backfilled — see app/core/pricing.py).
"""

from decimal import Decimal

from app.core.pricing import compute_cost


def test_compute_cost_known_model():
    # gpt-5.6-luna: $0.20 / $1.20 per million tokens.
    cost = compute_cost("gpt-5.6-luna", input_tokens=1_000_000, output_tokens=1_000_000)

    assert cost == Decimal("1.40")


def test_compute_cost_fractional_tokens_prices_proportionally():
    # gpt-5.6-terra: $2.00 / $12.00 per million tokens.
    cost = compute_cost("gpt-5.6-terra", input_tokens=500_000, output_tokens=250_000)

    assert cost == Decimal("4.00")


def test_compute_cost_unknown_model_returns_none():
    assert compute_cost("some-unlisted-model", input_tokens=100, output_tokens=100) is None


def test_compute_cost_missing_input_tokens_returns_none():
    assert compute_cost("gpt-5.6-luna", input_tokens=None, output_tokens=100) is None


def test_compute_cost_missing_output_tokens_returns_none():
    assert compute_cost("gpt-5.6-luna", input_tokens=100, output_tokens=None) is None


def test_compute_cost_zero_tokens_is_zero_not_none():
    assert compute_cost("gpt-5.6-luna", input_tokens=0, output_tokens=0) == Decimal("0")
