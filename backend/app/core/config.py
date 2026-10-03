"""Application configuration loaded exclusively from environment variables."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All settings come from environment variables only. No secrets in source."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App ---
    APP_NAME: str = "AI Interview Preparation System"
    APP_ENV: Literal["development", "testing", "production"] = "development"
    DEBUG: bool = False
    API_V1_PREFIX: str = "/api/v1"
    SECRET_KEY: str = Field(..., min_length=32, description="JWT signing secret")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    REFRESH_TOKEN_ROTATION_GRACE_DAYS: int = 3
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # --- Database ---
    DATABASE_URL: str = "postgresql+psycopg://postgres:postgres@localhost:5432/interview_db"

    # --- Redis ---
    REDIS_URL: str = "redis://localhost:6379/0"

    # --- S3-compatible object storage ---
    S3_ENDPOINT_URL: str | None = None
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET: str = "interview-resumes"
    S3_REGION: str = "us-east-1"
    SUPABASE_STORAGE_ENDPOINT: str | None = None
    SUPABASE_STORAGE_REGION: str | None = None
    SUPABASE_STORAGE_ACCESS_KEY: str = ""
    SUPABASE_STORAGE_SECRET_KEY: str = ""
    SUPABASE_STORAGE_BUCKET: str | None = None

    # --- AI provider ---
    AI_PROVIDER: Literal["nvidia", "openai", "anthropic", "test"] = "openai"
    AI_MODEL: str = ""
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-3-5-sonnet-latest"
    NVIDIA_API_KEY: str = ""
    NVIDIA_BASE_URL: str = "https://integrate.api.nvidia.com/v1"
    NVIDIA_LLM_MODEL: str = ""
    NVIDIA_STT_MODEL: str = ""
    NVIDIA_TTS_MODEL: str = ""
    NVIDIA_ASR_SERVER: str = "grpc.nvcf.nvidia.com:443"
    NVIDIA_TTS_SERVER: str = "grpc.nvcf.nvidia.com:443"
    NVIDIA_ASR_FUNCTION_ID: str = ""
    NVIDIA_TTS_FUNCTION_ID: str = ""
    NVIDIA_TTS_VOICE: str = ""
    NVIDIA_SPEECH_USE_SSL: bool = True
    AI_TEMPERATURE: float = 0.2
    AI_TIMEOUT_SECONDS: int = 120
    AI_MAX_RETRIES: int = 3
    AI_RETRY_BACKOFF_SECONDS: float = 1.5
    AI_MAX_RESUME_CHARS: int = 4000
    AI_MAX_ANSWER_CHARS: int = 12000
    AI_MAX_OUTPUT_TOKENS: int = 4096

    # --- Rate limiting ---
    RATE_LIMIT_DEFAULT: str = "100/minute"
    RATE_LIMIT_AUTH: str = "20/minute"
    RATE_LIMIT_INTERVIEW: str = "30/minute"
    RATE_LIMIT_UPLOAD: str = "10/hour"

    # --- File uploads ---
    MAX_UPLOAD_SIZE_MB: int = 10
    ALLOWED_UPLOAD_EXTENSIONS: set[str] = {".pdf", ".doc", ".docx"}

    # --- Worker ---
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"
    REALTIME_SESSION_TTL_SECONDS: int = 3600
    REALTIME_AUDIO_MAX_CHUNK_BYTES: int = 96000
    REALTIME_MAX_AUDIO_SECONDS: int = 300
    REALTIME_MAX_EVENT_BYTES: int = 262144

    @computed_field  # type: ignore[prop-decorator]
    @property
    def MAX_UPLOAD_SIZE_BYTES(self) -> int:
        return self.MAX_UPLOAD_SIZE_MB * 1024 * 1024

    @computed_field  # type: ignore[prop-decorator]
    @property
    def REFRESH_TOKEN_EXPIRE_SECONDS(self) -> int:
        return self.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60


@lru_cache
def get_settings() -> Settings:
    return Settings()