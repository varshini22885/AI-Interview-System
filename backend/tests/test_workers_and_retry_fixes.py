"""Unit tests for FIX 1 (workers.py idempotency/guards) and FIX 2 (retry.py provider retry)."""

import uuid
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.ai.exceptions import AIProviderError, AIRetryExhausted, AIValidationError
from app.ai.question_service import GeneratedQuestion
from app.ai.retry import run_with_retries
from app.ai.schemas import QuestionOutput
from app.db.base import Base
from app.interviews import service as svc
from app.interviews.exceptions import InterviewNotReady
from app.models.interview import DifficultyLevel, Interview, InterviewerPersona, InterviewQuestion, InterviewStatus, InterviewType
from app.models.user import User
from app.workers import generate_questions_work


@pytest.fixture()
def test_db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionFactory = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)
    session = SessionFactory()
    try:
        yield session, SessionFactory
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _make_user(session) -> User:
    u = User(
        id=uuid.uuid4(),
        email=f"test_{uuid.uuid4().hex[:8]}@example.com",
        full_name="Test Candidate",
        hashed_password="fake-hash-for-test",
    )
    session.add(u)
    session.commit()
    return u


def _make_interview(session, user: User, *, status=InterviewStatus.PREPARING, total_questions=2) -> Interview:
    iv = Interview(
        id=uuid.uuid4(),
        user_id=user.id,
        target_role="Software Engineer",
        programming_language="Python",
        interview_type=InterviewType.TECHNICAL.value,
        difficulty=DifficultyLevel.MEDIUM.value,
        interviewer_persona=InterviewerPersona.PROFESSIONAL.value,
        total_questions=total_questions,
        status=status.value if hasattr(status, "value") else str(status),
    )
    session.add(iv)
    session.commit()
    return iv


def _mock_generated_question(text="Explain Python GIL in detail"):
    return GeneratedQuestion(
        output=QuestionOutput(
            question_text=text,
            question_type="TECHNICAL",
            category="Concurrency",
            skill="Python",
            difficulty="MEDIUM",
            expected_concepts=["threading", "locks"],
            evaluation_rubric="Good explanation of GIL",
            follow_up_allowed=True,
            max_follow_ups=1,
        ),
        source="generated",
        attempts=1,
    )


# ---------------------------------------------------------------------------
# FIX 1 Tests (workers.py)
# ---------------------------------------------------------------------------

def test_preparing_interview_can_generate_questions(test_db, monkeypatch):
    """1. PREPARING interview can generate questions."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, total_questions=2)

    mock_gen = MagicMock()
    mock_gen.generate.side_effect = [
        _mock_generated_question("What is Python GIL in detail?"),
        _mock_generated_question("How does async/await work in Python?"),
    ]

    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    session.expire_all()
    db_iv = session.get(Interview, iv.id)
    assert db_iv.status == InterviewStatus.READY.value

    questions = session.execute(
        select(InterviewQuestion).where(InterviewQuestion.interview_id == iv.id)
    ).scalars().all()
    assert len(questions) == 2
    assert mock_gen.generate.call_count == 2


def test_failed_interview_does_not_call_nvidia(test_db, monkeypatch):
    """2. FAILED interview does not call NVIDIA."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, status=InterviewStatus.FAILED, total_questions=2)

    mock_gen = MagicMock()
    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    mock_gen.generate.assert_not_called()
    session.expire_all()
    db_iv = session.get(Interview, iv.id)
    assert db_iv.status == InterviewStatus.FAILED.value


def test_ready_interview_does_not_call_nvidia(test_db, monkeypatch):
    """3. READY interview does not call NVIDIA."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, status=InterviewStatus.READY, total_questions=2)

    mock_gen = MagicMock()
    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    mock_gen.generate.assert_not_called()
    session.expire_all()
    db_iv = session.get(Interview, iv.id)
    assert db_iv.status == InterviewStatus.READY.value


def test_existing_full_question_set_prevents_duplicate_generation(test_db, monkeypatch):
    """4. Existing full question set prevents duplicate generation and promotes PREPARING to READY."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, total_questions=2)

    # Insert 2 existing questions
    for i in range(2):
        session.add(
            InterviewQuestion(
                interview_id=iv.id,
                order_index=i,
                question_type="TECHNICAL",
                question_text=f"Existing Question number {i+1}",
                question_metadata={},
            )
        )
    session.commit()

    mock_gen = MagicMock()
    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    mock_gen.generate.assert_not_called()
    session.expire_all()
    db_iv = session.get(Interview, iv.id)
    assert db_iv.status == InterviewStatus.READY.value
    count = len(session.execute(select(InterviewQuestion).where(InterviewQuestion.interview_id == iv.id)).scalars().all())
    assert count == 2


def test_partial_existing_questions_generates_only_missing(test_db, monkeypatch):
    """5. Partial existing question set generates only missing questions."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, total_questions=3)

    session.add(
        InterviewQuestion(
            interview_id=iv.id,
            order_index=0,
            question_type="TECHNICAL",
            question_text="Existing Question number 1",
            question_metadata={},
        )
    )
    session.commit()

    mock_gen = MagicMock()
    mock_gen.generate.side_effect = [
        _mock_generated_question("What is Python generator function?"),
        _mock_generated_question("Explain Python metaclasses in detail."),
    ]

    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    assert mock_gen.generate.call_count == 2
    session.expire_all()
    questions = session.execute(
        select(InterviewQuestion).where(InterviewQuestion.interview_id == iv.id).order_by(InterviewQuestion.order_index)
    ).scalars().all()
    assert len(questions) == 3
    assert questions[0].question_text == "Existing Question number 1"
    assert questions[1].question_text == "What is Python generator function?"
    assert questions[2].question_text == "Explain Python metaclasses in detail."
    assert session.get(Interview, iv.id).status == InterviewStatus.READY.value


def test_existing_question_texts_included_in_asked_questions(test_db, monkeypatch):
    """6. Existing question texts are included in asked_questions passed to QuestionRequest."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, total_questions=2)

    session.add(
        InterviewQuestion(
            interview_id=iv.id,
            order_index=0,
            question_type="TECHNICAL",
            question_text="What is a Python generator?",
            question_metadata={},
        )
    )
    session.commit()

    captured_requests = []

    def mock_generate(req):
        captured_requests.append(req)
        return _mock_generated_question("Explain async/await in Python")

    mock_gen = MagicMock()
    mock_gen.generate.side_effect = mock_generate

    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    assert len(captured_requests) == 1
    assert "What is a Python generator?" in captured_requests[0].asked_questions


def test_order_index_continues_correctly_after_existing_questions(test_db, monkeypatch):
    """7. order_index continues correctly after existing questions and is strictly unique."""
    session, session_factory = test_db
    monkeypatch.setattr("app.workers.get_session_factory", lambda: session_factory)

    u = _make_user(session)
    iv = _make_interview(session, u, total_questions=3)

    session.add(
        InterviewQuestion(
            interview_id=iv.id,
            order_index=0,
            question_type="TECHNICAL",
            question_text="First initial technical question",
            question_metadata={},
        )
    )
    session.commit()

    mock_gen = MagicMock()
    mock_gen.generate.side_effect = [
        _mock_generated_question("Second question about databases"),
        _mock_generated_question("Third question about algorithms"),
    ]

    with patch("app.workers.QuestionGenerationService", return_value=mock_gen):
        generate_questions_work(interview_id=iv.id)

    session.expire_all()
    questions = session.execute(
        select(InterviewQuestion).where(InterviewQuestion.interview_id == iv.id).order_by(InterviewQuestion.order_index)
    ).scalars().all()

    order_indices = [q.order_index for q in questions]
    assert order_indices == [0, 1, 2]
    assert len(set(order_indices)) == 3


# ---------------------------------------------------------------------------
# FIX 2 Tests (retry.py)
# ---------------------------------------------------------------------------

def test_ai_provider_error_is_retried(monkeypatch):
    """8. AIProviderError is retried by run_with_retries."""
    monkeypatch.setattr("time.sleep", lambda s: None)

    attempts = 0

    def flaky_provider():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise AIProviderError("NVIDIA 504 Gateway Timeout")
        return "success"

    res, count = run_with_retries("nvidia_call", flaky_provider, max_attempts=3)
    assert res == "success"
    assert count == 2
    assert attempts == 2


def test_ai_validation_error_is_still_retried(monkeypatch):
    """9. AIValidationError is still retried by run_with_retries."""
    monkeypatch.setattr("time.sleep", lambda s: None)

    attempts = 0

    def flaky_validation():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise AIValidationError("Missing field: question_text")
        return "validated_response"

    res, count = run_with_retries("parse_call", flaky_validation, max_attempts=3)
    assert res == "validated_response"
    assert count == 2


def test_non_ai_exceptions_are_not_retried():
    """10. Non-AI exceptions are not retried by run_with_retries()."""
    attempts = 0

    def faulty_code():
        nonlocal attempts
        attempts += 1
        raise ValueError("Invalid database parameter")

    with pytest.raises(ValueError, match="Invalid database parameter"):
        run_with_retries("code_op", faulty_code, max_attempts=3)

    assert attempts == 1


def test_mark_ready_called_only_from_valid_preparing_state(test_db):
    """11. mark_ready() is called only from valid PREPARING state."""
    session, _ = test_db

    u = _make_user(session)
    iv = _make_interview(session, u, status=InterviewStatus.FAILED, total_questions=1)
    session.add(
        InterviewQuestion(
            interview_id=iv.id,
            order_index=0,
            question_type="TECHNICAL",
            question_text="Q1",
            question_metadata={},
        )
    )
    session.commit()

    with pytest.raises(InterviewNotReady, match="Interview must be PREPARING to become READY"):
        svc.mark_ready(session, user_id=u.id, interview_id=iv.id)
