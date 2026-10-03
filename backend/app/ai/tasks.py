"""Celery task boundaries for durable asynchronous interview work."""

from __future__ import annotations


def get_celery_app():
    from celery import Celery

    from app.core.config import get_settings

    settings = get_settings()
    app = Celery("interviews", broker=settings.CELERY_BROKER_URL, backend=settings.CELERY_RESULT_BACKEND)
    app.conf.update(
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        worker_prefetch_multiplier=1,
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        task_time_limit=settings.AI_TIMEOUT_SECONDS + 120,
        redis_socket_keepalive=True,
        redis_socket_timeout=30,
        redis_retry_on_timeout=True,
        broker_transport_options={
            "socket_keepalive": True,
            "socket_timeout": 30,
            "socket_connect_timeout": 30,
            "retry_on_timeout": True,
        },
        result_backend_transport_options={
            "socket_keepalive": True,
            "socket_timeout": 30,
            "socket_connect_timeout": 30,
            "retry_on_timeout": True,
        },
    )
    return app


celery_app = None


def _retry_if_transient(task, exc):
    from app.ai.exceptions import AIRetryExhausted, AIProviderError

    if isinstance(exc, (AIProviderError, AIRetryExhausted)) and task.request.retries < task.max_retries:
        raise task.retry(exc=exc, countdown=min(60, 2 ** task.request.retries))
    raise exc


def _app():
    global celery_app
    if celery_app is None:
        try:
            celery_app = get_celery_app()
        except Exception:
            celery_app = None
    return celery_app


_celery = None

try:
    _celery = _app()

    if _celery is not None:

        @_celery.task(name="ai.generate_questions", bind=True, max_retries=2)
        def generate_questions_task(self, *, interview_id: str) -> dict:
            from app.workers import generate_questions_work

            try:
                generate_questions_work(interview_id=interview_id)
            except Exception as exc:
                _retry_if_transient(self, exc)
            return {"interview_id": interview_id, "status": "completed"}

        @_celery.task(name="ai.evaluate_answer", bind=True, max_retries=2, autoretry_for=(), retry_backoff=True)
        def evaluate_answer_task(self, *, interview_id: str, question_id: str, answer_id: str) -> dict:
            from app.workers import evaluate_answer_work

            try:
                evaluate_answer_work(interview_id=interview_id, question_id=question_id, answer_id=answer_id)
            except Exception as exc:
                _retry_if_transient(self, exc)
            return {"interview_id": interview_id, "question_id": question_id, "answer_id": answer_id, "status": "completed"}

        @_celery.task(name="ai.generate_report", bind=True, max_retries=2)
        def generate_report_task(self, *, interview_id: str) -> dict:
            from app.workers import generate_report_work

            try:
                generate_report_work(interview_id=interview_id)
            except Exception as exc:
                _retry_if_transient(self, exc)
            return {"interview_id": interview_id, "status": "completed"}

        @_celery.task(name="resume.process_resume", bind=True, max_retries=2)
        def process_resume_task(self, *, resume_id: str) -> dict:
            from app.workers import process_resume_work

            try:
                process_resume_work(resume_id=resume_id)
            except Exception as exc:
                _retry_if_transient(self, exc)
            return {"resume_id": resume_id, "status": "completed"}
except Exception:
    _celery = None
