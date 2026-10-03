"""Provider-neutral speech interfaces.

Implementations must be configured with backend-only credentials. No default
implementation fabricates transcripts or audio.
"""

import wave
from dataclasses import dataclass
from io import BytesIO
from typing import Protocol


@dataclass(frozen=True)
class TranscriptEvent:
    text: str
    final: bool


class SpeechToTextProvider(Protocol):
    def start(self, *, audio_format: str) -> None: ...
    def process_chunk(self, chunk: bytes) -> list[TranscriptEvent]: ...
    def finish(self) -> TranscriptEvent: ...
    def close(self) -> None: ...


class TextToSpeechProvider(Protocol):
    def synthesize(self, text: str, *, audio_format: str) -> bytes: ...


class UnconfiguredSpeechProvider:
    """Explicit failure until a selected provider supplies speech support."""

    def start(self, *, audio_format: str) -> None:
        raise RuntimeError("Speech-to-text provider is not configured")

    def process_chunk(self, chunk: bytes) -> list[TranscriptEvent]:
        raise RuntimeError("Speech-to-text provider is not configured")

    def finish(self) -> TranscriptEvent:
        raise RuntimeError("Speech-to-text provider is not configured")

    def close(self) -> None:
        return None

    def synthesize(self, text: str, *, audio_format: str) -> bytes:
        raise RuntimeError("Text-to-speech provider is not configured")


class NvidiaSpeechToTextProvider:
    """True streaming ASR adapter for an NVIDIA Speech NIM via Riva gRPC."""

    def __init__(self, *, server: str, model: str, use_ssl: bool, language_code: str = "en-US", function_id: str | None = None, api_key: str | None = None) -> None:
        self.server = server
        self.model = model
        self.use_ssl = use_ssl
        self.language_code = language_code
        self.function_id = function_id or ""
        self.api_key = api_key or ""
        self._queue = None
        self._responses = None
        self._thread = None
        self._audio_format = None
        self._compressed_audio = bytearray()

    def _auth(self):
        import riva.client

        metadata = []
        if self.function_id:
            metadata.append(("function-id", self.function_id))
        if self.api_key:
            metadata.append(("authorization", f"Bearer {self.api_key}"))
        if self.api_key:
            metadata = [item for item in metadata if item[0] != "authorization"]
            metadata.append(("authorization", "Bearer " + self.api_key))
        return riva.client.Auth(uri=self.server, use_ssl=self.use_ssl, metadata_args=metadata)

    def start(self, *, audio_format: str) -> None:
        import queue
        import threading

        try:
            import riva.client
        except ImportError as exc:
            raise RuntimeError("NVIDIA Riva client is not installed") from exc
        self._queue = queue.Queue()
        self._response_queue = queue.Queue()
        self._audio_format = audio_format
        self._compressed_audio.clear()
        auth = self._auth()
        service = riva.client.ASRService(auth)
        config = riva.client.RecognitionConfig(
            language_code=self.language_code,
            model=self.model,
            max_alternatives=1,
            encoding=riva.client.AudioEncoding.LINEAR_PCM,
            sample_rate_hertz=16000,
        )
        streaming_config = riva.client.StreamingRecognitionConfig(config=config, interim_results=True)

        def audio_stream():
            while True:
                chunk = self._queue.get()
                if chunk is None:
                    return
                yield chunk

        self._responses = service.streaming_response_generator(audio_chunks=audio_stream(), streaming_config=streaming_config)
        self._thread = threading.Thread(target=self._consume, daemon=True)
        self._thread.start()

    def _consume(self) -> None:
        try:
            for response in self._responses:
                self._response_queue.put(response)
        except Exception as exc:
            self._response_queue.put(exc)

    def process_chunk(self, chunk: bytes) -> list[TranscriptEvent]:
        if self._queue is None:
            raise RuntimeError("ASR session is not started")
        if self._audio_format == "webm_opus":
            self._compressed_audio.extend(chunk)
            return []
        self._queue.put(chunk)
        events = []
        while not self._response_queue.empty():
            response = self._response_queue.get_nowait()
            if isinstance(response, Exception):
                raise RuntimeError("NVIDIA ASR request failed") from response
            for result in getattr(response, "results", []) or []:
                alternatives = getattr(result, "alternatives", []) or []
                if alternatives:
                    events.append(TranscriptEvent(text=alternatives[0].transcript, final=bool(getattr(result, "is_final", False))))
        return events

    def finish(self) -> TranscriptEvent:
        if self._queue is None:
            raise RuntimeError("ASR session is not started")
        if self._audio_format == "webm_opus":
            try:
                import av

                container = av.open(BytesIO(self._compressed_audio), format="webm")
                stream = container.streams.audio[0]
                resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
                for frame in container.decode(stream):
                    converted = resampler.resample(frame)
                    if not isinstance(converted, list):
                        converted = [converted]
                    for output_frame in converted:
                        self._queue.put(bytes(output_frame.planes[0]))
                flushed = resampler.resample(None)
                if not isinstance(flushed, list):
                    flushed = [flushed]
                for output_frame in flushed:
                    self._queue.put(bytes(output_frame.planes[0]))
                container.close()
            except ImportError as exc:
                raise RuntimeError("WebM audio conversion is not available") from exc
            except Exception as exc:
                raise RuntimeError("WebM audio conversion failed") from exc
        self._queue.put(None)
        if self._thread is not None:
            self._thread.join(timeout=30)
        events = []
        while not self._response_queue.empty():
            response = self._response_queue.get_nowait()
            if isinstance(response, Exception):
                raise RuntimeError("NVIDIA ASR request failed") from response
            for result in getattr(response, "results", []) or []:
                alternatives = getattr(result, "alternatives", []) or []
                if alternatives:
                    events.append(TranscriptEvent(text=alternatives[0].transcript, final=bool(getattr(result, "is_final", False))))
        final = next((event for event in reversed(events) if event.final), None)
        if final is None:
            raise RuntimeError("NVIDIA ASR returned no final transcript")
        return final

    def close(self) -> None:
        if self._queue is not None:
            self._queue.put(None)


# Riva LINEAR_PCM is raw 16-bit signed little-endian mono PCM (NVIDIA TTS tutorials
# decode with numpy int16). Magpie NIM / this adapter request 22050 Hz; the WAV
# header must use that same requested rate, not a different hardcoded rate.
_TTS_LINEAR_PCM_SAMPLE_RATE_HZ = 22050
_TTS_LINEAR_PCM_CHANNELS = 1
_TTS_LINEAR_PCM_SAMPLE_WIDTH = 2


def _linear_pcm_to_wav(pcm: bytes, *, sample_rate_hz: int, channels: int = 1, sample_width: int = 2) -> bytes:
    """Wrap NVIDIA LINEAR_PCM samples in a RIFF/WAVE container. Samples are unchanged."""
    if len(pcm) >= 12 and pcm[:4] == b"RIFF" and pcm[8:12] == b"WAVE":
        return pcm
    frame_size = channels * sample_width
    if frame_size < 1 or len(pcm) % frame_size != 0:
        raise RuntimeError("NVIDIA TTS LINEAR_PCM payload is not aligned to the PCM frame size")
    buffer = BytesIO()
    with wave.open(buffer, "wb") as container:
        container.setnchannels(channels)
        container.setsampwidth(sample_width)
        container.setframerate(sample_rate_hz)
        container.writeframes(pcm)
    return buffer.getvalue()


class NvidiaTextToSpeechProvider:
    """Request-based offline synthesis through the documented Riva client."""

    def __init__(self, *, server: str, model: str, voice: str, use_ssl: bool, language_code: str = "en-US", function_id: str | None = None, api_key: str | None = None) -> None:
        self.server = server
        self.model = model
        self.voice = voice
        self.use_ssl = use_ssl
        self.language_code = language_code
        self.function_id = function_id or ""
        self.api_key = api_key or ""

    def _auth(self):
        import riva.client

        metadata = []
        if self.function_id:
            metadata.append(("function-id", self.function_id))
        if self.api_key:
            metadata.append(("authorization", f"Bearer {self.api_key}"))
        return riva.client.Auth(uri=self.server, use_ssl=self.use_ssl, metadata_args=metadata)

    def synthesize(self, text: str, *, audio_format: str) -> bytes:
        if not text.strip() or len(text) > 2000:
            raise ValueError("TTS text must be 1-2000 characters")
        try:
            import riva.client
            from riva.client.proto.riva_audio_pb2 import AudioEncoding
        except ImportError as exc:
            raise RuntimeError("NVIDIA Riva client is not installed") from exc
        auth = self._auth()
        service = riva.client.SpeechSynthesisService(auth)
        encoding = AudioEncoding.OGGOPUS if audio_format == "ogg_opus" else AudioEncoding.LINEAR_PCM
        sample_rate_hz = _TTS_LINEAR_PCM_SAMPLE_RATE_HZ
        response = service.synthesize(
            text,
            self.voice,
            self.language_code,
            sample_rate_hz=sample_rate_hz,
            encoding=encoding,
            custom_dictionary={},
        )
        audio = bytes(response.audio)
        if audio_format == "ogg_opus":
            return audio
        return _linear_pcm_to_wav(
            audio,
            sample_rate_hz=sample_rate_hz,
            channels=_TTS_LINEAR_PCM_CHANNELS,
            sample_width=_TTS_LINEAR_PCM_SAMPLE_WIDTH,
        )


def get_speech_providers():
    from app.core.config import get_settings

    settings = get_settings()
    if settings.AI_PROVIDER != "nvidia":
        return UnconfiguredSpeechProvider(), UnconfiguredSpeechProvider()
    if not settings.NVIDIA_STT_MODEL or not settings.NVIDIA_TTS_MODEL or not settings.NVIDIA_TTS_VOICE:
        raise RuntimeError("NVIDIA speech models and voice must be configured")
    if not settings.NVIDIA_ASR_FUNCTION_ID or not settings.NVIDIA_TTS_FUNCTION_ID:
        raise RuntimeError("NVIDIA hosted speech function IDs must be configured")
    return (
        NvidiaSpeechToTextProvider(
            server=settings.NVIDIA_ASR_SERVER,
            model=settings.NVIDIA_STT_MODEL,
            use_ssl=settings.NVIDIA_SPEECH_USE_SSL,
            function_id=settings.NVIDIA_ASR_FUNCTION_ID,
            api_key=settings.NVIDIA_API_KEY,
        ),
        NvidiaTextToSpeechProvider(
            server=settings.NVIDIA_TTS_SERVER,
            model=settings.NVIDIA_TTS_MODEL,
            voice=settings.NVIDIA_TTS_VOICE,
            use_ssl=settings.NVIDIA_SPEECH_USE_SSL,
            function_id=settings.NVIDIA_TTS_FUNCTION_ID,
            api_key=settings.NVIDIA_API_KEY,
        ),
    )
