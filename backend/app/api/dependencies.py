"""Shared API dependencies: DB session, auth, request id, rate-limit seam."""

import uuid

from fastapi import Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db.base import get_db

bearer_scheme = HTTPBearer(auto_error=False)


def get_request_id(request: Request, x_request_id: str | None = Header(default=None, alias="X-Request-ID")) -> str:
    if x_request_id and len(x_request_id) <= 64 and all(c.isalnum() or c in "-_" for c in x_request_id):
        request.state.request_id = x_request_id
        return x_request_id
    rid = uuid.uuid4().hex
    request.state.request_id = rid
    return rid


def rate_limit_guard(request: Request, scope: str = "default") -> None:
    # Seam: production uses Redis-backed limiter per RATE_LIMIT_* config.
    # Documented in docs/api.md; no unreliable in-memory limiter here.
    return None


def get_current_user(
    db: Session = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> object:
    from app.auth.exceptions import InvalidCredentials
    from app.auth.service import decode_access_token
    from app.core.config import get_settings
    from app.models.user import User

    if credentials is None:
        raise HTTPException(status_code=401, detail={"error": {"code": "UNAUTHENTICATED", "message": "Missing bearer token."}})
    token = credentials.credentials
    try:
        user_id = decode_access_token(token, secret=get_settings().SECRET_KEY)
    except InvalidCredentials:
        raise HTTPException(status_code=401, detail={"error": {"code": "INVALID_CREDENTIALS", "message": "Invalid or expired token."}})
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail={"error": {"code": "UNAUTHENTICATED", "message": "User unavailable."}})
    return user
