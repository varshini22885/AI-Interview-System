"""Retry helper: bounded attempts, no unbounded AI calls."""

import time

from app.ai.exceptions import AIProviderError, AIRetryExhausted, AIValidationError

# Exceptions that are safe to retry (transient by nature).
_RETRYABLE = (AIValidationError, AIProviderError)


def run_with_retries(operation: str, fn, *, max_attempts: int):
    """Run *fn* up to *max_attempts* times, retrying on transient AI errors.

    Returns (result, attempt_number) on success.
    Raises AIRetryExhausted after all attempts are exhausted.
    """
    last: Exception | None = None
    attempts = max(1, int(max_attempts))
    for attempt in range(1, attempts + 1):
        try:
            result = fn()
            return result, attempt
        except _RETRYABLE as exc:
            last = exc
            if attempt >= attempts:
                break
            # Exponential backoff: 1s, 2s, … capped at 10s.
            time.sleep(min(2 ** (attempt - 1), 10))
    raise AIRetryExhausted(operation, attempts) from last
