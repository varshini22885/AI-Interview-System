"""Unit and integration tests for Realtime Session and WebSocket gateway."""

import os
import uuid
from datetime import datetime, timezone

os.environ.setdefault("SECRET_KEY", "test-secret-key-0123456789abcdef-xyz1234567890")
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ["AI_PROVIDER"] = "test"

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.main import app
from app.models.interview import Interview, InterviewQuestion, InterviewStatus
from app.models.realtime import RealtimeInterviewSession
from app.models.user import User

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)

    import app.db.base as base_mod
    base_mod.engine = engine
    base_mod.SessionLocal = TestingSession

    yield

    Base.metadata.drop_all(engine)
    engine.dispose()


def _register(email="user@example.com", password="password123"):
    r = client.post("/api/v1/auth/register", json={"email": email, "full_name": "Test User", "password": password})
    assert r.status_code == 201
    return r.json()


def _login(email="user@example.com", password="password123"):
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200
    return r.json()


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _create_active_interview(token, email="user@example.com"):
    from app.db.base import SessionLocal

    with SessionLocal() as db:
        user = db.query(User).filter_by(email=email).one()
        iv = Interview(
            user_id=user.id,
            target_role="Backend Engineer",
            interview_type="TECHNICAL",
            difficulty="MEDIUM",
            interviewer_persona="PROFESSIONAL",
            total_questions=2,
            current_question_index=0,
            status=InterviewStatus.WAITING_FOR_ANSWER.value,
            started_at=datetime.now(timezone.utc),
        )
        db.add(iv)
        db.commit()
        db.refresh(iv)

        q1 = InterviewQuestion(
            interview_id=iv.id,
            order_index=0,
            question_type="TECHNICAL",
            question_text="Explain database indexing and B-Trees.",
            question_metadata={"expected_concepts": ["indexing", "b-tree"], "evaluation_rubric": "Rubric"},
        )
        q2 = InterviewQuestion(
            interview_id=iv.id,
            order_index=1,
            question_type="TECHNICAL",
            question_text="How do you handle race conditions in distributed systems?",
            question_metadata={"expected_concepts": ["locks", "idempotency"], "evaluation_rubric": "Rubric"},
        )
        db.add_all([q1, q2])
        db.commit()
        return str(user.id), str(iv.id), str(q1.id)


def test_create_realtime_session():
    _register()
    t = _login()
    token = t["access_token"]
    user_id, iv_id, q_id = _create_active_interview(token)

    # 1. Create session
    r = client.post(f"/api/v1/interviews/{iv_id}/realtime/session", headers=_auth(token))
    assert r.status_code == 200, r.text
    data = r.json()
    assert "session_id" in data
    assert data["interview_id"] == iv_id
    assert data["status"] == "ACTIVE"
    assert "websocket_path" in data

    # 2. Re-requesting active session reuses existing
    r2 = client.post(f"/api/v1/interviews/{iv_id}/realtime/session", headers=_auth(token))
    assert r2.status_code == 200
    assert r2.json()["session_id"] == data["session_id"]


def test_create_realtime_session_inactive_interview():
    _register()
    t = _login()
    token = t["access_token"]

    # Create interview in PREPARING
    r = client.post("/api/v1/interviews", headers=_auth(token), json={"target_role": "Backend Engineer", "question_count": 2})
    iv_id = r.json()["id"]

    # Session creation rejected on PREPARING
    res = client.post(f"/api/v1/interviews/{iv_id}/realtime/session", headers=_auth(token))
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "INTERVIEW_NOT_ACTIVE"


def test_websocket_auth_failure():
    _register()
    t = _login()
    token = t["access_token"]
    user_id, iv_id, q_id = _create_active_interview(token)
    session_res = client.post(f"/api/v1/interviews/{iv_id}/realtime/session", headers=_auth(token)).json()
    session_id = session_res["session_id"]

    # 1. Missing token
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/v1/interviews/{iv_id}/realtime/ws?session_id={session_id}"):
            pass

    # 2. Invalid token
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/v1/interviews/{iv_id}/realtime/ws?session_id={session_id}&access_token=badtoken"):
            pass


def test_websocket_cross_user_forbidden():
    _register("user1@example.com")
    t1 = _login("user1@example.com")
    _register("user2@example.com")
    t2 = _login("user2@example.com")

    user_id, iv_id, q_id = _create_active_interview(t1["access_token"], email="user1@example.com")
    session_res = client.post(f"/api/v1/interviews/{iv_id}/realtime/session", headers=_auth(t1["access_token"])).json()
    session_id = session_res["session_id"]

    # User 2 tries to connect to User 1's realtime session
    with pytest.raises(Exception):
        with client.websocket_connect(f"/api/v1/interviews/{iv_id}/realtime/ws?session_id={session_id}&access_token={t2['access_token']}"):
            pass


def test_websocket_lifecycle_and_events(monkeypatch):
    import app.interviews.pipeline as pipeline
    dispatched = []
    monkeypatch.setattr(pipeline, "enqueue_answer_evaluation", lambda answer_id: dispatched.append(answer_id))

    _register()
    t = _login()
    token = t["access_token"]
    user_id, iv_id, q_id = _create_active_interview(token)
    session_res = client.post(f"/api/v1/interviews/{iv_id}/realtime/session", headers=_auth(token)).json()
    session_id = session_res["session_id"]

    ws_url = f"/api/v1/interviews/{iv_id}/realtime/ws?session_id={session_id}&access_token={token}"
    with client.websocket_connect(ws_url) as ws:
        # 1. Receive session_ack
        ack = ws.receive_json()
        assert ack["type"] == "session_ack"
        assert ack["session_id"] == session_id
        assert ack["interview_id"] == iv_id

        # 2. Receive initial question_started
        q_event = ws.receive_json()
        assert q_event["type"] == "question_started"
        assert q_event["question_id"] == q_id
        assert "indexing" in q_event["text"]

        # 3. Send heartbeat -> receive heartbeat_ack
        ws.send_json({"type": "heartbeat"})
        hb_ack = ws.receive_json()
        assert hb_ack["type"] == "heartbeat_ack"
        assert "timestamp" in hb_ack

        # 4. Send face_status -> receive face_status_ack
        ws.send_json({
            "type": "face_status",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "face_present": True,
            "face_count": 1,
            "head_pose": {"yaw": 0.0, "pitch": 0.0},
        })
        face_ack = ws.receive_json()
        assert face_ack["type"] == "face_status_ack"

        # 5. Send invalid event -> receive error
        ws.send_json({"type": "unsupported_event_type"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert err["code"] == "INVALID_EVENT"

        # 6. Send session_start -> receive question_started
        ws.send_json({"type": "session_start"})
        q_start = ws.receive_json()
        assert q_start["type"] == "question_started"
        assert q_start["question_id"] == q_id

        # 7. Submit answer via answer_complete
        ws.send_json({
            "type": "answer_complete",
            "question_id": q_id,
            "transcript": "B-Trees keep keys sorted to allow logarithmic time lookups and range queries.",
            "idempotency_key": "ws-idem-key-0001",
        })
        tf = ws.receive_json()
        assert tf["type"] == "transcript_final"
        assert "B-Trees" in tf["text"]

        ev_start = ws.receive_json()
        assert ev_start["type"] == "evaluation_started"
        assert ev_start["status"] == "EVALUATING"
        assert len(dispatched) == 1

        # 8. Send session_end -> closes connection
        ws.send_json({"type": "session_end"})
