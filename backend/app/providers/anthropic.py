import logging
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from app.logging_sdk import CallContext, CallFailure, CallOutcome
from app.providers.base import (
    ChatProvider,
    Provider,
    ProviderError,
    ProviderMessage,
    ProviderResult,
    ProviderStreamChunk,
)

logger = logging.getLogger(__name__)


class AnthropicProvider(ChatProvider):
    provider_name = Provider.ANTHROPIC

    def __init__(self, api_key: str, *, timeout_seconds: int) -> None:
        self._client = AsyncAnthropic(api_key=api_key, timeout=timeout_seconds)

    async def send_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> ProviderResult:
        request = self._build_request(messages, system=system, model=model, max_tokens=max_tokens)
        try:
            response = await self._client.messages.create(**request)
        except anthropic.APITimeoutError as exc:
            logger.error(
                "Anthropic request timed out",
                extra={"provider": self.provider_name, "model": model, "error_type": "timeout"},
            )
            raise ProviderError("timeout", _truncate(str(exc))) from exc
        except anthropic.APIConnectionError as exc:
            logger.error(
                "Anthropic connection failed",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "connection",
                },
            )
            raise ProviderError("connection", _truncate(str(exc))) from exc
        except anthropic.RateLimitError as exc:
            logger.error(
                "Anthropic rate limited",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "rate_limit",
                },
            )
            raise ProviderError("rate_limit", _truncate(str(exc)), status_code=429) from exc
        except anthropic.AuthenticationError as exc:
            logger.error(
                "Anthropic authentication failed",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "authentication",
                },
            )
            raise ProviderError("authentication", _truncate(str(exc)), status_code=401) from exc
        except anthropic.PermissionDeniedError as exc:
            logger.error(
                "Anthropic permission denied",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "permission",
                },
            )
            raise ProviderError("permission", _truncate(str(exc)), status_code=403) from exc
        except anthropic.NotFoundError as exc:
            logger.error(
                "Anthropic resource not found",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "not_found",
                },
            )
            raise ProviderError("not_found", _truncate(str(exc)), status_code=404) from exc
        except anthropic.ConflictError as exc:
            logger.error(
                "Anthropic conflict",
                extra={"provider": self.provider_name, "model": model, "error_type": "conflict"},
            )
            raise ProviderError("conflict", _truncate(str(exc)), status_code=409) from exc
        except anthropic.UnprocessableEntityError as exc:
            logger.error(
                "Anthropic unprocessable request",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "invalid_request",
                },
            )
            raise ProviderError("invalid_request", _truncate(str(exc)), status_code=422) from exc
        except anthropic.BadRequestError as exc:
            logger.error(
                "Anthropic bad request",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "invalid_request",
                },
            )
            raise ProviderError("invalid_request", _truncate(str(exc)), status_code=400) from exc
        except anthropic.InternalServerError as exc:
            logger.error(
                "Anthropic server error",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "server_error",
                },
            )
            raise ProviderError(
                "server_error", _truncate(str(exc)), status_code=exc.status_code
            ) from exc
        except anthropic.APIStatusError as exc:
            logger.error(
                "Anthropic API error",
                extra={"provider": self.provider_name, "model": model, "error_type": "api_error"},
            )
            raise ProviderError(
                "api_error", _truncate(str(exc)), status_code=exc.status_code
            ) from exc
        except anthropic.AnthropicError as exc:
            logger.error(
                "Anthropic unknown error",
                extra={"provider": self.provider_name, "model": model, "error_type": "unknown"},
            )
            raise ProviderError("unknown", _truncate(str(exc))) from exc

        return self._map_response(response)

    async def stream_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> AsyncIterator[ProviderStreamChunk]:
        request = self._build_request(messages, system=system, model=model, max_tokens=max_tokens)
        try:
            async with self._client.messages.stream(**request) as stream:
                async for text in stream.text_stream:
                    if text:
                        yield ProviderStreamChunk(delta=text)
                final_message = await stream.get_final_message()
                yield ProviderStreamChunk(delta="", result=self._map_response(final_message))
        except anthropic.APITimeoutError as exc:
            logger.error(
                "Anthropic request timed out",
                extra={"provider": self.provider_name, "model": model, "error_type": "timeout"},
            )
            raise ProviderError("timeout", _truncate(str(exc))) from exc
        except anthropic.APIConnectionError as exc:
            logger.error(
                "Anthropic connection failed",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "connection",
                },
            )
            raise ProviderError("connection", _truncate(str(exc))) from exc
        except anthropic.RateLimitError as exc:
            logger.error(
                "Anthropic rate limited",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "rate_limit",
                },
            )
            raise ProviderError("rate_limit", _truncate(str(exc)), status_code=429) from exc
        except anthropic.AuthenticationError as exc:
            logger.error(
                "Anthropic authentication failed",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "authentication",
                },
            )
            raise ProviderError("authentication", _truncate(str(exc)), status_code=401) from exc
        except anthropic.PermissionDeniedError as exc:
            logger.error(
                "Anthropic permission denied",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "permission",
                },
            )
            raise ProviderError("permission", _truncate(str(exc)), status_code=403) from exc
        except anthropic.NotFoundError as exc:
            logger.error(
                "Anthropic resource not found",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "not_found",
                },
            )
            raise ProviderError("not_found", _truncate(str(exc)), status_code=404) from exc
        except anthropic.ConflictError as exc:
            logger.error(
                "Anthropic conflict",
                extra={"provider": self.provider_name, "model": model, "error_type": "conflict"},
            )
            raise ProviderError("conflict", _truncate(str(exc)), status_code=409) from exc
        except anthropic.UnprocessableEntityError as exc:
            logger.error(
                "Anthropic unprocessable request",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "invalid_request",
                },
            )
            raise ProviderError("invalid_request", _truncate(str(exc)), status_code=422) from exc
        except anthropic.BadRequestError as exc:
            logger.error(
                "Anthropic bad request",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "invalid_request",
                },
            )
            raise ProviderError("invalid_request", _truncate(str(exc)), status_code=400) from exc
        except anthropic.InternalServerError as exc:
            logger.error(
                "Anthropic server error",
                extra={
                    "provider": self.provider_name,
                    "model": model,
                    "error_type": "server_error",
                },
            )
            raise ProviderError(
                "server_error", _truncate(str(exc)), status_code=exc.status_code
            ) from exc
        except anthropic.APIStatusError as exc:
            logger.error(
                "Anthropic API error",
                extra={"provider": self.provider_name, "model": model, "error_type": "api_error"},
            )
            raise ProviderError(
                "api_error", _truncate(str(exc)), status_code=exc.status_code
            ) from exc
        except anthropic.AnthropicError as exc:
            logger.error(
                "Anthropic unknown error",
                extra={"provider": self.provider_name, "model": model, "error_type": "unknown"},
            )
            raise ProviderError("unknown", _truncate(str(exc))) from exc

    def _build_request(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
    ) -> dict[str, Any]:
        # No `temperature`: claude-sonnet-5 rejects non-default sampling
        # params with a 400. Recorded in request_params/config_hash via
        # describe_call instead — see describe_call below.
        return {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
        }

    def _map_response(self, response: Any) -> ProviderResult:
        content = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        )

        usage = response.usage
        input_tokens = getattr(usage, "input_tokens", None) if usage is not None else None
        output_tokens = getattr(usage, "output_tokens", None) if usage is not None else None

        return ProviderResult(
            content=content,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=response.model,
            provider=Provider.ANTHROPIC,
            stop_reason=response.stop_reason,
            provider_metadata={
                "stop_reason": response.stop_reason,
                "response_model": response.model,
            },
        )

    def describe_call(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
        temperature: float,
        conversation_id: int | None = None,
    ) -> CallContext:
        return CallContext(
            provider=self.provider_name,
            model=model,
            system_prompt=system,
            input_messages=[
                {"role": "system", "content": system},
                *({"role": m["role"], "content": m["content"]} for m in messages),
            ],
            request_params={"max_tokens": max_tokens, "temperature": temperature},
            conversation_id=conversation_id,
        )

    def describe_outcome(self, result: ProviderResult) -> CallOutcome:
        return CallOutcome(
            output_text=result.content,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            provider_metadata=result.provider_metadata,
        )

    def describe_stream_outcome(self, chunks: list[ProviderStreamChunk]) -> CallOutcome:
        final = chunks[-1].result  # guaranteed non-None per stream_message's contract
        return self.describe_outcome(final)

    def describe_failure(self, exc: BaseException) -> CallFailure:
        if isinstance(exc, ProviderError):
            return CallFailure(error_type=exc.error_type, error_message=exc.message)
        return CallFailure(error_type=type(exc).__name__, error_message=str(exc))


def _truncate(message: str, limit: int = 500) -> str:
    return message[:limit]
