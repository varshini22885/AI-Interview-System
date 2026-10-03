"""Unit tests for VendorProvider JSON extraction, schema validation, and error handling."""

import pytest
from pydantic import BaseModel, Field

from app.ai.exceptions import AIValidationError
from app.ai.provider import AIMetadata
from app.ai.providers.vendor import (
    VendorProvider,
    _clean_json_text,
    _extract_json_payload,
    _safe_snippet,
)
from app.ai.schemas import QuestionOutput


class SampleSchema(BaseModel):
    name: str = Field(min_length=2)
    score: int = Field(ge=0, le=100)


@pytest.fixture
def vendor():
    return VendorProvider("nvidia")


@pytest.fixture
def dummy_meta():
    return AIMetadata(provider="test", model="test-model", operation="test_op")


def test_safe_snippet():
    assert _safe_snippet(None) == "<empty>"
    assert _safe_snippet("") == "<empty>"
    short = "hello world"
    assert _safe_snippet(short) == short
    long_text = "a" * 400
    snippet = _safe_snippet(long_text, max_len=100)
    assert len(snippet) < 200
    assert "..." in snippet


def test_parse_raw_json(vendor, dummy_meta):
    raw = '{"question_text": "Explain indexing in PostgreSQL and its trade-offs?", "question_type": "TECHNICAL", "category": "databases", "skill": "postgresql", "difficulty": "HARD", "expected_concepts": ["b-tree", "write-overhead"], "evaluation_rubric": "Needs b-tree and write overhead.", "follow_up_allowed": true, "max_follow_ups": 2}'
    result = vendor._parse(raw, "generate_question", dummy_meta, QuestionOutput)
    assert result.data.question_text.startswith("Explain indexing")
    assert result.data.difficulty == "HARD"
    assert result.data.max_follow_ups == 2


def test_parse_fenced_json(vendor, dummy_meta):
    fenced = """```json
{
  "question_text": "How do you handle distributed transactions across microservices?",
  "question_type": "TECHNICAL",
  "category": "distributed-systems",
  "skill": "saga-pattern",
  "difficulty": "HARD",
  "expected_concepts": ["2pc", "saga", "idempotency"],
  "evaluation_rubric": "Requires 2pc vs saga trade-offs.",
  "follow_up_allowed": true,
  "max_follow_ups": 1
}
```"""
    result = vendor._parse(fenced, "generate_question", dummy_meta, QuestionOutput)
    assert "distributed transactions" in result.data.question_text
    assert result.data.skill == "saga-pattern"


def test_parse_whitespace_around_json(vendor, dummy_meta):
    noisy = """

    Here is the question requested:
    {
      "question_text": "Tell me about a time you had a major conflict with a peer.",
      "question_type": "BEHAVIORAL",
      "category": "conflict-resolution",
      "skill": "collaboration",
      "difficulty": "MEDIUM",
      "expected_concepts": ["active-listening", "resolution"],
      "evaluation_rubric": "Look for de-escalation and positive outcome.",
      "follow_up_allowed": true,
      "max_follow_ups": 1
    }
    Hope this helps!
    """
    result = vendor._parse(noisy, "generate_question", dummy_meta, QuestionOutput)
    assert "major conflict" in result.data.question_text
    assert result.data.question_type == "BEHAVIORAL"


def test_parse_malformed_response(vendor, dummy_meta):
    malformed = "This is not JSON at all and contains no braces."
    with pytest.raises(AIValidationError) as exc:
        vendor._parse(malformed, "generate_question", dummy_meta, QuestionOutput)
    assert "did not return JSON" in str(exc.value)


def test_parse_structured_output_response(vendor, dummy_meta):
    payload_str = '{"name": "Alice", "score": 95}'
    result = vendor._parse(payload_str, "sample_op", dummy_meta, SampleSchema)
    assert result.data.name == "Alice"
    assert result.data.score == 95


def test_parse_reasoning_content_separation(vendor, dummy_meta):
    # Simulated model output where <think> reasoning tags are embedded before JSON
    mixed = """<think>
We should generate a hard question about cache stampede and distributed locking.
Let's make sure rubric covers mutex locking, probabilistic early expiration.
</think>
{
  "question_text": "How do you mitigate cache stampede under extreme read loads?",
  "question_type": "TECHNICAL",
  "category": "caching",
  "skill": "cache-stampede",
  "difficulty": "HARD",
  "expected_concepts": ["mutex", "probabilistic-early-expiration", "single-flight"],
  "evaluation_rubric": "Candidate must explain mutex locking and background refresh.",
  "follow_up_allowed": true,
  "max_follow_ups": 2
}"""
    result = vendor._parse(mixed, "generate_question", dummy_meta, QuestionOutput)
    assert "cache stampede" in result.data.question_text
    assert result.data.category == "caching"


def test_parse_schema_validation_failure(vendor, dummy_meta):
    # Missing required fields and bad types
    invalid_schema_json = '{"question_text": "Short", "question_type": "INVALID_TYPE"}'
    with pytest.raises(AIValidationError) as exc:
        vendor._parse(invalid_schema_json, "generate_question", dummy_meta, QuestionOutput)
    assert "schema validation failed" in str(exc.value)


def test_parse_nested_question_wrapper(vendor, dummy_meta):
    wrapped = """{
      "question": {
        "question_text": "Explain memory management in Python and reference counting.",
        "question_type": "TECHNICAL",
        "category": "python-internals",
        "skill": "memory-management",
        "difficulty": "HARD",
        "expected_concepts": ["reference-counting", "cyclic-gc", "gil"],
        "evaluation_rubric": "Award credit for reference counting and generational cyclic GC.",
        "follow_up_allowed": true,
        "max_follow_ups": 1
      }
    }"""
    result = vendor._parse(wrapped, "generate_question", dummy_meta, QuestionOutput)
    assert "memory management" in result.data.question_text
