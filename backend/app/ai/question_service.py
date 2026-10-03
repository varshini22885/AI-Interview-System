"""Question generation service: AI + deterministic validation + bank fallback."""

from dataclasses import dataclass

from app.ai.exceptions import AIFallbackExhausted, AIQuestionRejected
from app.ai.question_bank import QuestionBank, get_default_bank
from app.ai.retry import run_with_retries
from app.ai.schemas import QuestionOutput

PROHIBITED = ("ignore previous instructions", "system prompt", "api key", "reveal")
MAX_Q_LEN = 2000


@dataclass(frozen=True)
class QuestionRequest:
    role: str
    language: str | None
    interview_type: str
    difficulty: str
    persona: str
    resume_summary: str
    asked_questions: list[str]
    count: int = 1


@dataclass(frozen=True)
class GeneratedQuestion:
    output: QuestionOutput
    source: str
    attempts: int


def _normalize(text: str) -> str:
    import re

    return re.sub(r"\s+", " ", text.strip().lower())


def _norm_enum(value) -> str:
    """Upper-cased enum value; tolerant of legacy 'InterviewType.TECHNICAL' strings."""
    raw = getattr(value, "value", value)
    text = str(raw).upper() if raw is not None else ""
    # Legacy py3.10 str(Enum) form e.g. 'INTERVIEWTYPE.TECHNICAL' -> 'TECHNICAL'.
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def validate_question(candidate: QuestionOutput, req: QuestionRequest) -> None:
    text = candidate.question_text.strip()
    if len(text) < 10 or len(text) > MAX_Q_LEN:
        raise AIQuestionRejected("Bad question length")
    if _norm_enum(candidate.difficulty) != _norm_enum(req.difficulty):
        raise AIQuestionRejected("Difficulty mismatch")
    if _norm_enum(req.interview_type) != "MIXED" and _norm_enum(candidate.question_type) != _norm_enum(req.interview_type):
        raise AIQuestionRejected("Interview-type mismatch")
    if not candidate.expected_concepts or not candidate.evaluation_rubric.strip():
        raise AIQuestionRejected("Missing concepts/rubric")
    lowered = text.lower()
    if any(p in lowered for p in PROHIBITED):
        raise AIQuestionRejected("Prohibited content")
    if "?" in text and "=" in text and "answer is" in lowered:
        raise AIQuestionRejected("Answer embedded in question")
    norm = _normalize(text)
    for asked in req.asked_questions:
        if norm == _normalize(asked) or (len(norm) > 40 and norm in _normalize(asked)):
            raise AIQuestionRejected("Duplicate question")
    if req.language and candidate.question_type == "TECHNICAL":
        if req.language.lower() not in (candidate.skill.lower() + " " + text.lower() + " " + candidate.category.lower()):
            raise AIQuestionRejected("Language relevance failed")


class QuestionGenerationService:
    def __init__(self, provider=None, bank: QuestionBank | None = None) -> None:
        self.provider = provider
        self.bank = bank or get_default_bank()

    def _provider(self):
        if self.provider is not None:
            return self.provider
        from app.ai.provider import get_provider

        return get_provider()

    def generate(self, req: QuestionRequest) -> GeneratedQuestion:
        from app.ai.prompts import build_question_prompt
        from app.core.config import get_settings

        settings = get_settings()
        if req.count < 1 or req.count > 5:
            raise AIQuestionRejected("count must be 1-5")
        prompt = build_question_prompt(role=req.role, language=req.language, interview_type=_norm_enum(req.interview_type) or "MIXED", difficulty=_norm_enum(req.difficulty) or "MEDIUM", persona=req.persona, resume_summary=req.resume_summary[: settings.AI_MAX_RESUME_CHARS], asked=req.asked_questions, count=1)

        def _call():
            result = self._provider().generate_question(prompt, schema=QuestionOutput)
            validate_question(result.data, req)
            return result

        try:
            result, attempts = run_with_retries("generate_question", _call, max_attempts=settings.AI_MAX_RETRIES)
            return GeneratedQuestion(output=result.data, source="ai", attempts=attempts)
        except Exception:
            # Deterministic safety net: the bank uses progressively relaxed
            # matching (language, then type, then difficulty) so a small bank
            # or an over-strict vendor response can never wedge the interview
            # in PREPARING. Relaxed bank entries intentionally skip
            # validate_question (their type/difficulty/language may differ)
            # but must still satisfy the schema's minimum quality bar.
            fallback = self.bank.find_one(role=req.role, language=req.language, interview_type=req.interview_type, difficulty=req.difficulty, exclude=req.asked_questions)
            if fallback is None:
                raise AIFallbackExhausted("No valid fallback question")
            text = (fallback.question_text or "").strip()
            if len(text) < 10 or len(text) > MAX_Q_LEN:
                raise AIFallbackExhausted("No valid fallback question")
            if not fallback.expected_concepts or not (fallback.evaluation_rubric or "").strip():
                raise AIFallbackExhausted("No valid fallback question")
            return GeneratedQuestion(output=fallback, source="bank", attempts=settings.AI_MAX_RETRIES)
