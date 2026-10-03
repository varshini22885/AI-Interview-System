"""FastAPI application factory: CORS from env, request ids, error mapping."""

import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.ai.exceptions import AIError
from app.api.errors import domain_exception_handler
from app.api.router import api_router
from app.auth.exceptions import AuthError
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.interviews.exceptions import InterviewDomainError


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.DEBUG)
    app = FastAPI(title=settings.APP_NAME, version="1.0.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.CORS_ORIGINS),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        rid = request.headers.get("X-Request-ID")
        if not rid or len(rid) > 64 or not all(c.isalnum() or c in "-_" for c in rid):
            rid = uuid.uuid4().hex
        request.state.request_id = rid
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        return response

    for exc_type in (InterviewDomainError, AuthError, AIError):
        app.add_exception_handler(exc_type, domain_exception_handler)

    @app.exception_handler(422)
    async def validation_handler(request: Request, exc):
        rid = getattr(request.state, "request_id", uuid.uuid4().hex)
        return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION_ERROR", "message": "Request validation failed.", "request_id": rid}})

    @app.get("/health/live", tags=["Health"], summary="Liveness")
    def live():
        return {"status": "ok"}

    @app.get("/health/ready", tags=["Health"], summary="Readiness")
    def ready():
        from fastapi import HTTPException

        test_database = settings.DATABASE_URL.startswith("sqlite") and settings.APP_ENV != "production"
        database = "ok"
        redis_status = "ok"
        if test_database:
            database = "test-double"
            redis_status = "test-double"
        else:
            try:
                from app.db.base import get_engine

                with get_engine().connect() as connection:
                    connection.execute(text("SELECT 1"))
            except Exception:
                database = "unavailable"
            try:
                import redis

                redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=1, socket_timeout=1).ping()
                redis_status = "ok"
            except Exception:
                redis_status = "unavailable"
        dependencies_ok = database in ("ok", "test-double") and redis_status in ("ok", "test-double")
        body = {"status": "ok" if dependencies_ok else "degraded", "database": database, "redis": redis_status, "ai_provider": settings.AI_PROVIDER}
        if body["status"] != "ok":
            raise HTTPException(status_code=503, detail=body)
        return body

    app.include_router(api_router, prefix=settings.API_V1_PREFIX)
    return app


app = create_app()
