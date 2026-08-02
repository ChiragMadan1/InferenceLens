from app.core.pricing import compute_cost
from app.models import InferenceLog
from app.schemas import InferenceLogEventIn


def build_log(event: InferenceLogEventIn) -> InferenceLog:
    """The single event -> row mapping, shared by HTTP ingestion and the
    Kafka consumer so cost computation and row shape never drift between
    transports.
    """
    cost = compute_cost(event.model, event.input_tokens, event.output_tokens)
    return InferenceLog(**event.model_dump(), cost_usd=cost)
