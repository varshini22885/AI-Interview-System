"""Vendor provider: lazy SDK imports, structured JSON, no secrets in logs."""

import json
import logging
import re
import time
from typing import Any

from app.ai.exceptions import AIConfigurationError, AIProviderError, AIValidationError
from app.ai.provider import AIMetadata, AIResult

logger = logging.getLogger(__name__)


def _safe_snippet(text: str | None, max_len: int = 300) -> str:
    if not text:
        return "<empty>"
    if len(text) <= max_len:
        return text
    half = max_len // 2
    return f"{text[:half]}...[+{len(text) - max_len} chars]...{text[-half:]}"


def _clean_json_text(text: str) -> str:
    cleaned = (text or "").strip()
    # Strip <think>...</think> reasoning blocks if model embeds them into content
    cleaned = re.sub(r"<think>.*?</think>", "", cleaned, flags=re.DOTALL).strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    return cleaned


def _extract_json_payload(text: str) -> dict | list:
    cleaned = _clean_json_text(text)
    # 1. Direct JSON parse
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        pass

    # 2. Extract outermost { ... }
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidate = cleaned[first_brace : last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # 3. Extract outermost [ ... ]
    first_bracket = cleaned.find("[")
    last_bracket = cleaned.rfind("]")
    if first_bracket != -1 and last_bracket != -1 and last_bracket > first_bracket:
        candidate = cleaned[first_bracket : last_bracket + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # Final attempt to raise clear JSONDecodeError
    return json.loads(cleaned)


class VendorProvider:
    name: str

    def __init__(self, provider_name: str) -> None:
        self.name = provider_name

    def _settings(self):
        from app.core.config import get_settings

        return get_settings()

    def _call(self, prompt: str, operation: str, max_tokens: int, schema: Any = None) -> tuple[str, AIMetadata]:
        from app.core.config import get_settings

        settings = get_settings()
        started = time.monotonic()
        if self.name in ("openai", "nvidia"):
            api_key = settings.OPENAI_API_KEY if self.name == "openai" else settings.NVIDIA_API_KEY
            model = settings.OPENAI_MODEL if self.name == "openai" else settings.NVIDIA_LLM_MODEL
            base_url = None if self.name == "openai" else settings.NVIDIA_BASE_URL
            if not api_key:
                raise AIConfigurationError(f"{self.name.upper()}_API_KEY is not configured")
            if not model:
                raise AIConfigurationError(f"{self.name.upper()} model is not configured")
            try:
                from openai import OpenAI
            except ImportError as exc:
                raise AIConfigurationError("openai SDK is not installed") from exc
            client = OpenAI(api_key=api_key, base_url=base_url, timeout=settings.AI_TIMEOUT_SECONDS)

            response_format: dict[str, Any] = {"type": "json_object"}
            if schema is not None and hasattr(schema, "model_json_schema"):
                response_format = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": getattr(schema, "__name__", "StructuredOutput"),
                        "schema": schema.model_json_schema(),
                    },
                }

            try:
                try:
                    resp = client.chat.completions.create(
                        model=model,
                        messages=[{"role": "user", "content": prompt}],
                        temperature=settings.AI_TEMPERATURE,
                        max_tokens=max_tokens,
                        response_format=response_format,
                    )
                except Exception as exc:
                    # Fallback to json_object if json_schema is rejected by a specific model endpoint
                    if response_format.get("type") == "json_schema":
                        logger.warning("json_schema format unsupported by endpoint, falling back to json_object: %s", exc)
                        resp = client.chat.completions.create(
                            model=model,
                            messages=[{"role": "user", "content": prompt}],
                            temperature=settings.AI_TEMPERATURE,
                            max_tokens=max_tokens,
                            response_format={"type": "json_object"},
                        )
                    else:
                        raise
            except Exception as exc:
                raise AIProviderError(f"{self.name.upper()} call failed: {type(exc).__name__}") from exc

            choice = resp.choices[0]
            finish_reason = getattr(choice, "finish_reason", None)
            text = choice.message.content or ""
            reasoning = getattr(choice.message, "reasoning_content", None)
            reasoning_len = len(reasoning) if reasoning else 0

            usage: dict = {}
            try:
                u = resp.usage
                if u is not None:
                    usage = {
                        "prompt_tokens": getattr(u, "prompt_tokens", 0),
                        "completion_tokens": getattr(u, "completion_tokens", 0),
                        "total_tokens": getattr(u, "total_tokens", 0),
                    }
            except Exception:
                usage = {}

            latency_ms = int((time.monotonic() - started) * 1000)
            logger.info(
                "Vendor LLM [%s] op=%s finish_reason=%s latency_ms=%d content_len=%d reasoning_len=%d usage=%s snippet=%r",
                self.name,
                operation,
                finish_reason,
                latency_ms,
                len(text),
                reasoning_len,
                usage,
                _safe_snippet(text),
            )

            if not text.strip():
                if finish_reason == "length":
                    raise AIProviderError(
                        f"{operation}: model output truncated (finish_reason=length, token limit reached during generation)"
                    )
                raise AIValidationError(
                    f"{operation}: model returned empty content (finish_reason={finish_reason})"
                )

            meta = AIMetadata(
                provider=self.name,
                model=model,
                operation=operation,
                latency_ms=latency_ms,
                usage=usage,
            )
            return text, meta

        if self.name == "anthropic":
            if not settings.ANTHROPIC_API_KEY:
                raise AIConfigurationError("ANTHROPIC_API_KEY is not configured")
            try:
                import anthropic as anthropic_sdk
            except ImportError as exc:
                raise AIConfigurationError("anthropic SDK is not installed") from exc
            client = anthropic_sdk.Anthropic(api_key=settings.ANTHROPIC_API_KEY, timeout=settings.AI_TIMEOUT_SECONDS)
            try:
                resp = client.messages.create(
                    model=settings.ANTHROPIC_MODEL,
                    max_tokens=max_tokens,
                    temperature=settings.AI_TEMPERATURE,
                    messages=[{"role": "user", "content": prompt}],
                )
            except Exception as exc:
                raise AIProviderError(f"Anthropic call failed: {type(exc).__name__}") from exc
            parts = getattr(resp, "content", []) or []
            text = "".join(getattr(p, "text", "") for p in parts)
            usage = {}
            try:
                usage = {
                    "input_tokens": getattr(resp.usage, "input_tokens", 0),
                    "output_tokens": getattr(resp.usage, "output_tokens", 0),
                }
            except Exception:
                usage = {}

            latency_ms = int((time.monotonic() - started) * 1000)
            logger.info(
                "Vendor LLM [anthropic] op=%s latency_ms=%d content_len=%d usage=%s snippet=%r",
                operation,
                latency_ms,
                len(text),
                usage,
                _safe_snippet(text),
            )

            if not text.strip():
                raise AIValidationError(f"{operation}: model returned empty content")

            meta = AIMetadata(
                provider="anthropic",
                model=settings.ANTHROPIC_MODEL,
                operation=operation,
                latency_ms=latency_ms,
                usage=usage,
            )
            return text, meta
        raise AIConfigurationError(f"Unknown vendor {self.name!r}")

    def _parse(self, text: str, operation: str, meta: AIMetadata, schema):
        from pydantic import ValidationError

        try:
            payload = _extract_json_payload(text)
        except (json.JSONDecodeError, TypeError) as exc:
            raise AIValidationError(f"{operation}: model did not return JSON") from exc

        if not isinstance(payload, (dict, list)):
            raise AIValidationError(f"{operation}: model returned non-structured JSON payload")

        if isinstance(payload, list) and len(payload) == 1 and isinstance(payload[0], dict):
            payload = payload[0]

        if isinstance(payload, dict) and "question" in payload and "question_text" not in payload and isinstance(payload["question"], dict):
            payload = payload["question"]

        if isinstance(payload, dict):
            if "difficulty" in payload and isinstance(payload["difficulty"], str):
                payload["difficulty"] = payload["difficulty"].strip().upper()
            if "question_type" in payload and isinstance(payload["question_type"], str):
                payload["question_type"] = payload["question_type"].strip().upper()

            str_fields = {
                "evaluation_rubric",
                "strengths",
                "improvements",
                "factual_feedback",
                "communication_feedback",
                "detailed_feedback",
                "summary",
                "reason",
                "areas_for_improvement",
            }
            for k in str_fields:
                if k not in payload:
                    continue
                if isinstance(payload[k], list):
                    payload[k] = "\n".join(str(x) for x in payload[k])
                elif isinstance(payload[k], dict):
                    payload[k] = json.dumps(payload[k], ensure_ascii=False)
                elif not isinstance(payload[k], str):
                    payload[k] = str(payload[k])
                max_len = getattr(schema.model_fields.get(k), "max_length", None) if hasattr(schema, "model_fields") else None
                if max_len and len(payload[k]) > max_len:
                    payload[k] = payload[k][:max_len]

        try:
            data = schema.model_validate(payload)
        except ValidationError as exc:
            raise AIValidationError(f"{operation}: schema validation failed") from exc

        return AIResult(data=data, meta=meta)

    def generate_question(self, prompt: str, *, schema) -> AIResult:
        from app.core.config import get_settings

        text, meta = self._call(prompt, "generate_question", get_settings().AI_MAX_OUTPUT_TOKENS, schema=schema)
        return self._parse(text, "generate_question", meta, schema)

    def evaluate_answer(self, prompt: str, *, schema) -> AIResult:
        from app.core.config import get_settings

        text, meta = self._call(prompt, "evaluate_answer", get_settings().AI_MAX_OUTPUT_TOKENS, schema=schema)
        return self._parse(text, "evaluate_answer", meta, schema)

    def generate_follow_up(self, prompt: str, *, schema) -> AIResult:
        from app.core.config import get_settings

        text, meta = self._call(prompt, "generate_follow_up", get_settings().AI_MAX_OUTPUT_TOKENS, schema=schema)
        return self._parse(text, "generate_follow_up", meta, schema)

    def generate_interview_feedback(self, prompt: str, *, schema) -> AIResult:
        from app.core.config import get_settings

        text, meta = self._call(prompt, "generate_interview_feedback", get_settings().AI_MAX_OUTPUT_TOKENS, schema=schema)
        return self._parse(text, "generate_interview_feedback", meta, schema)

    def generate_performance_report(self, prompt: str, *, schema) -> AIResult:
        from app.core.config import get_settings

        text, meta = self._call(prompt, "generate_performance_report", get_settings().AI_MAX_OUTPUT_TOKENS, schema=schema)
        return self._parse(text, "generate_performance_report", meta, schema)
