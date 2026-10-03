"""Curated question bank: deterministic fallback only (no random filler)."""

from app.ai.schemas import QuestionOutput

BANK: list[QuestionOutput] = [
    QuestionOutput(question_text="Explain how a Python dictionary works internally and when you would prefer it over a list for lookups, including time-complexity trade-offs.", question_type="TECHNICAL", category="data-structures", skill="Python", difficulty="MEDIUM", expected_concepts=["hash-table", "average-O(1)-lookup", "key-hashability"], evaluation_rubric="Credit hashing, average O(1), hashable keys, list-vs-dict trade-off.", follow_up_allowed=True, max_follow_ups=1),
    QuestionOutput(question_text="Describe a time you resolved a disagreement with a teammate about a technical approach. What did you do and what was the outcome?", question_type="BEHAVIORAL", category="teamwork", skill="communication", difficulty="MEDIUM", expected_concepts=["conflict-resolution", "listening", "ownership"], evaluation_rubric="Credit STAR structure, specific actions, measurable outcome.", follow_up_allowed=True, max_follow_ups=1),
    QuestionOutput(question_text="Explain Python list vs tuple differences and when you would choose a tuple in a backend service.", question_type="TECHNICAL", category="data-structures", skill="Python", difficulty="EASY", expected_concepts=["mutability", "hashability", "use-cases"], evaluation_rubric="Credit mutability, hashability, and practical guidance.", follow_up_allowed=True, max_follow_ups=1),
    QuestionOutput(question_text="Design a rate limiter for a backend API serving a Backend Developer workload. Discuss algorithm choice, edge cases, and scaling.", question_type="TECHNICAL", category="system-design", skill="backend", difficulty="HARD", expected_concepts=["token-bucket", "edge-cases", "distributed-state"], evaluation_rubric="Credit algorithm, correctness under concurrency, scaling trade-offs.", follow_up_allowed=True, max_follow_ups=2),
    QuestionOutput(question_text="Walk through how you would design a REST API endpoint for user authentication, covering input validation, error responses, and rate-limiting considerations.", question_type="TECHNICAL", category="backend", skill="Python", difficulty="MEDIUM", expected_concepts=["input-validation", "http-status-codes", "rate-limiting"], evaluation_rubric="Credit validation strategy, correct status codes, abuse prevention, and secure token handling.", follow_up_allowed=True, max_follow_ups=1),
    QuestionOutput(question_text="Tell me about a time you had to learn a new technology quickly for a project. How did you approach it and what was the result?", question_type="BEHAVIORAL", category="adaptability", skill="communication", difficulty="MEDIUM", expected_concepts=["learning-strategy", "time-management", "outcome-reflection"], evaluation_rubric="Credit a concrete situation, a deliberate learning approach, and a reflective outcome.", follow_up_allowed=True, max_follow_ups=1),
]


def _norm(text: str) -> str:
    import re

    return re.sub(r"\s+", " ", text.strip().lower())


class QuestionBank:
    def __init__(self, entries: list[QuestionOutput] | None = None) -> None:
        self.entries = list(entries) if entries is not None else list(BANK)

    def find_one(self, *, role: str, language: str | None, interview_type: str, difficulty: str, exclude: list[str]) -> QuestionOutput | None:
        excluded = {_norm(q) for q in exclude}
        raw = str(getattr(interview_type, "value", interview_type) or "MIXED").upper()
        # Tolerant of legacy py3.10 str(Enum) e.g. 'INTERVIEWTYPE.TECHNICAL'.
        wanted = raw.rsplit(".", 1)[-1] if "." in raw else raw
        want_diff = str(getattr(difficulty, "value", difficulty) or "MEDIUM").upper().rsplit(".", 1)[-1] if "." in str(getattr(difficulty, "value", difficulty) or "MEDIUM").upper() else str(getattr(difficulty, "value", difficulty) or "MEDIUM").upper()
        # MIXED accepts every bank question type; TECHNICAL/BEHAVIORAL filter,
        # and FOLLOW_UP entries are persistence-only (never generated).
        for entry in self.entries:
            qtype = entry.question_type.upper()
            if qtype == "FOLLOW_UP":
                continue
            if wanted != "MIXED" and qtype != wanted:
                continue
            if entry.difficulty.upper() != want_diff:
                continue
            if language and entry.question_type.upper() == "TECHNICAL" and language.lower() not in (entry.skill + " " + entry.category + " " + entry.question_text).lower():
                continue
            if _norm(entry.question_text) in excluded:
                continue
            return entry
        # Second pass: relax the language hint so a language-specific request
        # can never leave the interview stuck in PREPARING with an empty bank.
        if language:
            for entry in self.entries:
                qtype = entry.question_type.upper()
                if qtype == "FOLLOW_UP":
                    continue
                if wanted != "MIXED" and qtype != wanted:
                    continue
                if entry.difficulty.upper() != want_diff:
                    continue
                if _norm(entry.question_text) in excluded:
                    continue
                return entry
        # Final pass: any non-duplicate entry of the right difficulty so the
        # deterministic safety net always yields a question when non-empty.
        for entry in self.entries:
            if entry.question_type.upper() == "FOLLOW_UP":
                continue
            if entry.difficulty.upper() != want_diff:
                continue
            if _norm(entry.question_text) in excluded:
                continue
            return entry
        # Last resort: any non-duplicate, non-FOLLOW_UP entry (cross-difficulty)
        # so a small bank can still satisfy interviews asking for >N questions
        # of one difficulty instead of failing the whole interview.
        for entry in self.entries:
            if entry.question_type.upper() == "FOLLOW_UP":
                continue
            if _norm(entry.question_text) in excluded:
                continue
            return entry
        return None


def get_default_bank() -> QuestionBank:
    return QuestionBank()
