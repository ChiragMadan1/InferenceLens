from decimal import Decimal

# Bump whenever any rate below changes. Stored costs are NOT backfilled —
# a log's cost_usd reflects the map version in effect when it was ingested.
PRICE_MAP_VERSION = "2026-08-01"

# model id -> (input USD per million tokens, output USD per million tokens)
PRICE_MAP: dict[str, tuple[Decimal, Decimal]] = {
    "gpt-5.6-terra": (Decimal("2.00"), Decimal("12.00")),
    "gpt-5.6-luna": (Decimal("0.20"), Decimal("1.20")),
}

_MILLION = Decimal("1000000")


def compute_cost(
    model: str, input_tokens: int | None, output_tokens: int | None
) -> Decimal | None:
    """Cost in USD for one provider call, or None when it cannot be computed.

    Returns None (never raises) when the model is absent from PRICE_MAP or
    either token count is missing — an unpriced log is still a valid log.
    """
    rates = PRICE_MAP.get(model)
    if rates is None or input_tokens is None or output_tokens is None:
        return None
    input_rate, output_rate = rates
    return (
        Decimal(input_tokens) * input_rate + Decimal(output_tokens) * output_rate
    ) / _MILLION
