"""Interview routes: authenticate -> validate -> service -> respond."""

import uuid

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user, get_request_id, rate_limit_guard
from app.api.schemas import InterviewCreateRequest, InterviewSummaryResponse, Page, RealtimeSessionResponse
from app.db.base import get_db

router = APIRouter(prefix="/interviews", tags=["Interviews"])


@router.post("/{interview_id}/realtime/session", response_model=RealtimeSessionResponse, summary="Create realtime session")
def create_realtime_session(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from datetime import datetime, timezone
    from app.models.interview import InterviewStatus
    from app.models.realtime import RealtimeInterviewSession

    iv = __import__("app.interviews.service", fromlist=["get_user_interview"]).get_user_interview(db, interview_id, user.id)
    if str(iv.status) not in (InterviewStatus.IN_PROGRESS.value, InterviewStatus.WAITING_FOR_ANSWER.value, InterviewStatus.FOLLOW_UP_REQUIRED.value, InterviewStatus.EVALUATING.value):
        from app.interviews.exceptions import InterviewNotActive
        raise InterviewNotActive("Interview is not active.")
    row = db.query(RealtimeInterviewSession).filter_by(interview_id=iv.id, user_id=user.id, status="ACTIVE").one_or_none()
    if row is None:
        row = RealtimeInterviewSession(interview_id=iv.id, user_id=user.id, status="ACTIVE", started_at=datetime.now(timezone.utc))
        db.add(row)
        db.commit()
        db.refresh(row)
    return {"session_id": str(row.id), "interview_id": str(iv.id), "status": row.status, "websocket_path": f"/api/v1/interviews/{iv.id}/realtime/ws?session_id={row.id}"}


@router.websocket("/{interview_id}/realtime/ws")
async def realtime_ws(websocket: WebSocket, interview_id: uuid.UUID, session_id: uuid.UUID):
    from app.realtime.websocket import handle_connection

    await handle_connection(websocket, interview_id=interview_id, session_id=session_id)


def _summary(iv) -> InterviewSummaryResponse:
    return InterviewSummaryResponse(
        id=iv.id,
        status=str(iv.status),
        target_role=iv.target_role,
        interview_type=str(iv.interview_type),
        difficulty=str(iv.difficulty),
        interviewer_persona=str(iv.interviewer_persona),
        total_questions=iv.total_questions,
        current_question_index=iv.current_question_index,
        created_at=iv.created_at,
    )


def _detail_dict(iv) -> dict:
    detail = _summary(iv).model_dump()
    detail.update({"started_at": iv.started_at, "completed_at": iv.completed_at, "updated_at": iv.updated_at})
    return detail


@router.post("", response_model=InterviewSummaryResponse, status_code=201, summary="Create interview")
def create_interview(payload: InterviewCreateRequest, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc

    rate_limit_guard(request, "interview")
    iv = svc.create_interview(db, user_id=user.id, resume_id=payload.resume_id, target_role=payload.target_role, programming_language=payload.programming_language, interview_type=payload.interview_type, difficulty=payload.difficulty, interviewer_persona=payload.interviewer_persona, question_count=payload.question_count)
    try:
        svc.begin_preparation(db, user_id=user.id, interview_id=iv.id)
        from app.interviews.pipeline import enqueue_question_generation

        # Server-authoritative dispatch: the worker (Celery in production,
        # documented inline fallback in dev/test) owns question generation.
        enqueue_question_generation(interview_id=iv.id)
    except Exception:
        # Preparation/dispatch failure must not fail interview creation, but
        # it is never silent: log for observability; the interview stays
        # PREPARING/FAILED and the client polls GET /interviews/{id}.
        import logging as _logging

        _logging.getLogger(__name__).exception("interview preparation dispatch failed (interview_id=%s, request_id=%s)", iv.id, request.headers.get("X-Request-ID"))
    # The inline/queued worker mutates the interview in its OWN session;
    # this request's session must not serve stale identity-map state.
    db.expire_all()
    iv = svc.get_user_interview(db, iv.id, user.id)
    return _summary(iv)


@router.get("", response_model=Page, summary="List my interviews")
def list_interviews(request: Request, page: int = Query(ge=1, default=1), page_size: int = Query(ge=1, le=100, default=20), db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from sqlalchemy import func, select

    from app.models.interview import Interview

    total = db.scalar(select(func.count()).select_from(Interview).where(Interview.user_id == user.id)) or 0
    rows = db.execute(select(Interview).where(Interview.user_id == user.id).order_by(Interview.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).scalars().all()
    return Page(items=[_summary(r) for r in rows], page=page, page_size=page_size, total=total)


@router.get("/{interview_id}", response_model=dict, summary="Interview detail")
def get_interview(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc
    from app.models.interview import InterviewStatus

    iv = svc.get_user_interview(db, interview_id, user.id)
    detail = _detail_dict(iv)
    detail["report_available"] = str(iv.status) == InterviewStatus.REPORT_READY.value
    return detail


@router.post("/{interview_id}/start", response_model=InterviewSummaryResponse, summary="Start interview")
def start(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc

    rate_limit_guard(request, "interview")
    return _summary(svc.start_interview(db, user_id=user.id, interview_id=interview_id))


@router.get("/{interview_id}/current", response_model=dict, summary="Current question")
def current(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc
    from app.models.interview import InterviewStatus

    iv = svc.get_user_interview(db, interview_id, user.id)
    q = svc.get_current_question(db, user_id=user.id, interview_id=interview_id)
    follow_up = None
    if str(iv.status) == InterviewStatus.FOLLOW_UP_REQUIRED.value:
        fu = svc.get_latest_follow_up(db, user_id=user.id, interview_id=interview_id)
        if fu is not None:
            follow_up = {"follow_up_text": fu.follow_up_text, "reason": fu.reason}
    return {"interview_id": str(iv.id), "status": str(iv.status), "order_index": q.order_index, "total_questions": iv.total_questions, "question_id": str(q.id), "question_type": str(q.question_type), "question_text": q.question_text, "answer_allowed": str(iv.status) in (InterviewStatus.WAITING_FOR_ANSWER.value, InterviewStatus.FOLLOW_UP_REQUIRED.value), "follow_up": follow_up}


@router.post("/{interview_id}/answers", response_model=dict, status_code=202, summary="Submit answer (async evaluation)")
def submit_answer(interview_id: uuid.UUID, payload: dict, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.api.schemas import AnswerSubmitRequest
    from app.interviews import service as svc

    rate_limit_guard(request, "interview")
    body = AnswerSubmitRequest.model_validate(payload)
    key = request.headers.get("Idempotency-Key") or body.idempotency_key
    if not key:
        from app.interviews.exceptions import InvalidAnswer

        raise InvalidAnswer("Idempotency-Key header (or idempotency_key) is required")
    res = svc.submit_answer(db, user_id=user.id, interview_id=interview_id, question_id=body.question_id, answer_text=body.answer_text, idempotency_key=key)
    if not res["is_duplicate"]:
        from app.interviews.pipeline import enqueue_answer_evaluation

        # 202 contract: answer persisted, interview EVALUATING; the worker
        # (Celery in production) owns evaluation and the follow-up/advance flow.
        enqueue_answer_evaluation(answer_id=res["answer"].id)
    status = res["status"]
    return {"answer_id": str(res["answer"].id), "attempt_number": res["answer"].attempt_number, "status": str(status.value if hasattr(status, "value") else status), "is_duplicate": bool(res["is_duplicate"]), "accepted": True}


@router.post("/{interview_id}/pause", summary="Pause (unsupported)")
def pause(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc

    return svc.pause_interview(db, user_id=user.id, interview_id=interview_id)


@router.post("/{interview_id}/resume", summary="Resume position")
def resume(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc

    out = svc.resume_interview(db, user_id=user.id, interview_id=interview_id)
    iv = out["interview"]
    q = out["question"]
    return {"interview_id": str(iv.id), "status": str(iv.status), "question_id": str(q.id) if q is not None else None, "order_index": q.order_index if q is not None else None}


@router.post("/{interview_id}/finish", response_model=InterviewSummaryResponse, summary="Finish interview")
def finish(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    from app.interviews import service as svc
    from app.models.interview import InterviewStatus

    iv = svc.finish_interview(db, user_id=user.id, interview_id=interview_id, manual=True)
    if str(iv.status) == InterviewStatus.COMPLETED.value:
        from app.interviews.pipeline import enqueue_report_generation

        enqueue_report_generation(interview_id=iv.id)
    return _summary(iv)


@router.get("/{interview_id}/evaluations", response_model=list[dict], summary="Persisted answer evaluations")
def list_evaluations(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    """Read-only projection of persisted AnswerEvaluation rows (ownership-checked).

    Exposes the candidate's own evaluation results only; never the rubric or
    question metadata used to produce them.
    """
    from app.interviews import service as svc

    return svc.list_interview_evaluations(db, interview_id=interview_id, user_id=user.id)


@router.get("/{interview_id}/transcript", summary="Interview transcript (questions, answers, follow-ups)")
def transcript(interview_id: uuid.UUID, request: Request, db: Session = Depends(get_db), user=Depends(get_current_user), _rid: str = Depends(get_request_id)):
    """Read-only ordered transcript so the UI can reconstruct state after a
    refresh; never exposes rubric, metadata, or other users' data."""
    from app.interviews import service as svc

    return svc.list_interview_transcript(db, interview_id=interview_id, user_id=user.id)

