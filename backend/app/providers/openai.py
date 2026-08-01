import logging
from typing import Any

import openai
from openai import AsyncOpenAI

from app.providers.base import (
    ChatProvider,
    Provider,
    ProviderError,
    ProviderMessage,
    ProviderResult,
)

logger = logging.getLogger(__name__)


class OpenAIProvider(ChatProvider):
    name = Provider.OPENAI

    def __init__(self, api_key: str, *, timeout_seconds: int) -> None:
        self._client = AsyncOpenAI(api_key=api_key, timeout=timeout_seconds)

    async def send_message(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
    ) -> ProviderResult:
        request = self._build_request(messages, system=system, model=model, max_tokens=max_tokens)
        try:
            response = await self._client.responses.create(**request)
        except openai.APITimeoutError as exc:
            logger.error(
                "OpenAI request timed out",
                extra={"provider": self.name, "model": model, "error_type": "timeout"},
            )
            raise ProviderError("timeout", _truncate(str(exc))) from exc
        except openai.APIConnectionError as exc:
            logger.error(
                "OpenAI connection failed",
                extra={"provider": self.name, "model": model, "error_type": "connection"},
            )
            raise ProviderError("connection", _truncate(str(exc))) from exc
        except openai.RateLimitError as exc:
            logger.error(
                "OpenAI rate limited",
                extra={"provider": self.name, "model": model, "error_type": "rate_limit"},
            )
            raise ProviderError("rate_limit", _truncate(str(exc)), status_code=429) from exc
        except openai.AuthenticationError as exc:
            logger.error(
                "OpenAI authentication failed",
                extra={"provider": self.name, "model": model, "error_type": "authentication"},
            )
            raise ProviderError("authentication", _truncate(str(exc)), status_code=401) from exc
        except openai.PermissionDeniedError as exc:
            logger.error(
                "OpenAI permission denied",
                extra={"provider": self.name, "model": model, "error_type": "permission"},
            )
            raise ProviderError("permission", _truncate(str(exc)), status_code=403) from exc
        except openai.NotFoundError as exc:
            logger.error(
                "OpenAI resource not found",
                extra={"provider": self.name, "model": model, "error_type": "not_found"},
            )
            raise ProviderError("not_found", _truncate(str(exc)), status_code=404) from exc
        except openai.ConflictError as exc:
            logger.error(
                "OpenAI conflict",
                extra={"provider": self.name, "model": model, "error_type": "conflict"},
            )
            raise ProviderError("conflict", _truncate(str(exc)), status_code=409) from exc
        except openai.UnprocessableEntityError as exc:
            logger.error(
                "OpenAI unprocessable request",
                extra={"provider": self.name, "model": model, "error_type": "invalid_request"},
            )
            raise ProviderError("invalid_request", _truncate(str(exc)), status_code=422) from exc
        except openai.BadRequestError as exc:
            logger.error(
                "OpenAI bad request",
                extra={"provider": self.name, "model": model, "error_type": "invalid_request"},
            )
            raise ProviderError("invalid_request", _truncate(str(exc)), status_code=400) from exc
        except openai.InternalServerError as exc:
            logger.error(
                "OpenAI server error",
                extra={"provider": self.name, "model": model, "error_type": "server_error"},
            )
            raise ProviderError(
                "server_error", _truncate(str(exc)), status_code=exc.status_code
            ) from exc
        except openai.APIStatusError as exc:
            logger.error(
                "OpenAI API error",
                extra={"provider": self.name, "model": model, "error_type": "api_error"},
            )
            raise ProviderError(
                "api_error", _truncate(str(exc)), status_code=exc.status_code
            ) from exc
        except openai.OpenAIError as exc:
            logger.error(
                "OpenAI unknown error",
                extra={"provider": self.name, "model": model, "error_type": "unknown"},
            )
            raise ProviderError("unknown", _truncate(str(exc))) from exc

        return self._map_response(response)

    def _build_request(
        self,
        messages: list[ProviderMessage],
        *,
        system: str,
        model: str,
        max_tokens: int,
    ) -> dict[str, Any]:
        return {
            "model": model,
            "instructions": system,
            "input": [{"role": m["role"], "content": m["content"]} for m in messages],
            "max_output_tokens": max_tokens,
            "reasoning": {"effort": "none"},
            "store": False,
        }

    def _map_response(self, response: Any) -> ProviderResult:
        content = getattr(response, "output_text", None) or ""

        usage = getattr(response, "usage", None)
        input_tokens = getattr(usage, "input_tokens", None) if usage is not None else None
        output_tokens = getattr(usage, "output_tokens", None) if usage is not None else None

        status = response.status
        incomplete_details = getattr(response, "incomplete_details", None)
        incomplete_reason = (
            getattr(incomplete_details, "reason", None) if incomplete_details else None
        )
        stop_reason = incomplete_reason if status == "incomplete" else status

        provider_metadata: dict[str, Any] = {
            "status": status,
            "response_id": response.id,
        }
        if incomplete_reason is not None:
            provider_metadata["incomplete_reason"] = incomplete_reason

        if usage is not None:
            input_tokens_details = getattr(usage, "input_tokens_details", None)
            cached_tokens = (
                getattr(input_tokens_details, "cached_tokens", None)
                if input_tokens_details is not None
                else None
            )
            if cached_tokens is not None:
                provider_metadata["cached_tokens"] = cached_tokens

            output_tokens_details = getattr(usage, "output_tokens_details", None)
            reasoning_tokens = (
                getattr(output_tokens_details, "reasoning_tokens", None)
                if output_tokens_details is not None
                else None
            )
            if reasoning_tokens is not None:
                provider_metadata["reasoning_tokens"] = reasoning_tokens

        return ProviderResult(
            content=content,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=response.model,
            provider=Provider.OPENAI,
            stop_reason=stop_reason,
            provider_metadata=provider_metadata,
        )


def _truncate(message: str, limit: int = 500) -> str:
    return message[:limit]
