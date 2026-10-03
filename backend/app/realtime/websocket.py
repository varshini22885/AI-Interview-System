"""WebSocket gateway; business state remains in the interview service."""

import asyncio
import base64
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Literal, get_args, get_origin

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.auth.service import decode_access_token
from app.core.config import get_settings
from app.db.base import get_session_factory
from app.models.interview import InterviewStatus
from app.models.realtime import RealtimeInterviewSession
from app.realtime.schemas import CLIENT_MESSAGES


def _parse_message(payload: dict):
    event_type = payload.get("type")
    for schema in CLIENT_MESSAGES:
        annotation = schema.model_fields["type"].annotation
        if get_origin(annotation) is Literal:
            valid_types = get_args(annotation)
            if event_type in valid_types:
                return schema.model_validate(payload)
    raise ValueError("Unsupported event type")


async def _send(websocket: WebSocket, event_type: str, **payload) -> None:
    await websocket.send_json({"type": event_type, **payload})


async def handle_connection(websocket: WebSocket, *, interview_id: uuid.UUID, session_id: uuid.UUID) -> None:
    settings = get_settings()
    token = websocket.query_params.get("access_token")
    if not token:
        await websocket.close(code=1008, reason="Authentication required")
        return
    try:
        user_id = decode_access_token(token, secret=settings.SECRET_KEY)
    except Exception:
        await websocket.close(code=1008, reason="Authentication failed")
        return

    db = get_session_factory()()
    stt = None
    tts = None
    audio_started = None
    message_count = 0
    try:
        session = db.get(RealtimeInterviewSession, session_id)
        if session is None or session.interview_id != interview_id or session.user_id != user_id or session.status != "ACTIVE":
            await websocket.close(code=1008, reason="Realtime session unavailable")
            return
        interview = db.get(__import__("app.models.interview", fromlist=["Interview"]).Interview, interview_id)
        if interview is None or interview.user_id != user_id:
            await websocket.close(code=1008, reason="Realtime session unavailable")
            return
        await websocket.accept()
        session.last_seen_at = datetime.now(timezone.utc)
        db.commit()
        await _send(websocket, "session_ack", session_id=str(session.id), interview_id=str(interview.id), status=str(interview.status))
        await _send_current_question(websocket, db, interview)
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > 256_000:
                await _send(websocket, "error", code="PAYLOAD_TOO_LARGE", message="Event exceeds the payload limit.")
                continue
            try:
                message = _parse_message(json.loads(raw))
            except (ValueError, TypeError, json.JSONDecodeError, ValidationError):
                await _send(websocket, "error", code="INVALID_EVENT", message="Invalid realtime event.")
                continue
            message_count += 1
            if message_count > 2000:
                await _send(websocket, "error", code="SESSION_LIMIT", message="Realtime session message limit reached.")
                break
            session.last_seen_at = datetime.now(timezone.utc)
            db.commit()
            if message.type == "heartbeat":
                await _send(websocket, "heartbeat_ack", timestamp=datetime.now(timezone.utc).isoformat())
            elif message.type == "session_start":
                await _send_current_question(websocket, db, interview)
            elif message.type == "face_status":
                await _send(websocket, "face_status_ack", timestamp=message.timestamp.isoformat())
            elif message.type in ("audio_start", "audio_chunk", "audio_end"):
                try:
                    if stt is None:
                        from app.ai.speech import get_speech_providers

                        stt, tts = get_speech_providers()
                    if message.type == "audio_start":
                        stt.start(audio_format="webm_opus")
                        audio_started = time.monotonic()
                        await _send(websocket, "audio_ack", event=message.type)
                    elif message.type == "audio_chunk":
                        if audio_started is None:
                            raise ValueError("audio_start is required")
                        chunk = base64.b64decode(message.data, validate=True)
                        if len(chunk) > settings.REALTIME_AUDIO_MAX_CHUNK_BYTES or time.monotonic() - audio_started > settings.REALTIME_MAX_AUDIO_SECONDS:
                            await _send(websocket, "error", code="PAYLOAD_TOO_LARGE", message="Audio session limit exceeded.")
                            continue
                        for event in await asyncio.to_thread(stt.process_chunk, chunk):
                            await _send(websocket, "transcript_final" if event.final else "transcript_partial", text=event.text)
                    else:
                        final = await asyncio.to_thread(stt.finish)
                        await _submit_transcript(websocket, db, interview, {"question_id": str((await _current_question_id(db, interview))), "transcript": final.text, "idempotency_key": uuid.uuid4().hex})
                        audio_started = None
                except ValueError:
                    await _send(websocket, "error", code="INVALID_EVENT", message="Invalid audio payload.")
                except RuntimeError as exc:
                    code = "STT_NOT_CONFIGURED" if "not configured" in str(exc).lower() else "STT_UNAVAILABLE"
                    await _send(websocket, "error", code=code, message="Speech recognition is unavailable.")
            elif message.type == "answer_complete":
                await _submit_transcript(websocket, db, interview, message.model_dump())
            elif message.type == "session_end":
                session.status = "ENDED"
                session.ended_at = datetime.now(timezone.utc)
                session.disconnect_reason = "client_requested"
                db.commit()
                await websocket.close(code=1000)
                return
    except WebSocketDisconnect:
        session = locals().get("session")
        if session is not None:
            session.disconnect_reason = "client_disconnect"
            session.last_seen_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


async def _send_current_question(websocket: WebSocket, db, interview) -> None:
    from app.interviews import service as svc

    if str(interview.status) not in (InterviewStatus.IN_PROGRESS.value, InterviewStatus.WAITING_FOR_ANSWER.value, InterviewStatus.FOLLOW_UP_REQUIRED.value, InterviewStatus.EVALUATING.value):
        return
    question = svc.get_current_question(db, user_id=interview.user_id, interview_id=interview.id)
    await _send(websocket, "question_started", question_id=str(question.id), text=question.question_text, status=str(interview.status))
    if get_settings().AI_PROVIDER == "nvidia":
        try:
            from app.ai.speech import get_speech_providers

            _, tts = get_speech_providers()
            audio = await asyncio.to_thread(tts.synthesize, question.question_text, audio_format="wav")
            await _send(websocket, "audio_started", audio_format="wav")
            await _send(websocket, "audio_chunk", data=base64.b64encode(audio).decode("ascii"), audio_format="wav")
        except RuntimeError:
            await _send(websocket, "error", code="TTS_UNAVAILABLE", message="Question speech is unavailable.")


async def _submit_transcript(websocket: WebSocket, db, interview, message) -> None:
    from app.interviews import service as svc
    from app.interviews.pipeline import enqueue_answer_evaluation

    result = svc.submit_answer(db, user_id=interview.user_id, interview_id=interview.id, question_id=uuid.UUID(message["question_id"]), answer_text=message["transcript"], idempotency_key=message["idempotency_key"])
    await _send(websocket, "transcript_final", text=message["transcript"])
    await _send(websocket, "evaluation_started", answer_id=str(result["answer"].id), status="EVALUATING")
    if not result["is_duplicate"]:
        enqueue_answer_evaluation(answer_id=result["answer"].id)


async def _current_question_id(db, interview):
    from app.interviews import service as svc

    return svc.get_current_question(db, user_id=interview.user_id, interview_id=interview.id).id
