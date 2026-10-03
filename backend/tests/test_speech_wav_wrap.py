"""WAV wrapping for NVIDIA LINEAR_PCM TTS samples (no live NVIDIA calls)."""

import wave
from io import BytesIO

from app.ai.speech import (
    _TTS_LINEAR_PCM_CHANNELS,
    _TTS_LINEAR_PCM_SAMPLE_RATE_HZ,
    _TTS_LINEAR_PCM_SAMPLE_WIDTH,
    _linear_pcm_to_wav,
)


def _pcm_bytes(n_frames: int = 22050) -> bytes:
    # 16-bit signed little-endian silence, same layout as Riva LINEAR_PCM.
    return b"\x00\x00" * n_frames


def test_linear_pcm_to_wav_writes_riff_wave_and_preserves_samples():
    pcm = _pcm_bytes(480)
    wav = _linear_pcm_to_wav(
        pcm,
        sample_rate_hz=_TTS_LINEAR_PCM_SAMPLE_RATE_HZ,
        channels=_TTS_LINEAR_PCM_CHANNELS,
        sample_width=_TTS_LINEAR_PCM_SAMPLE_WIDTH,
    )
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    with wave.open(BytesIO(wav), "rb") as container:
        assert container.getnchannels() == 1
        assert container.getsampwidth() == 2
        assert container.getframerate() == 22050
        assert container.readframes(container.getnframes()) == pcm


def test_linear_pcm_to_wav_does_not_double_wrap_existing_wav():
    pcm = _pcm_bytes(64)
    wav = _linear_pcm_to_wav(pcm, sample_rate_hz=22050)
    again = _linear_pcm_to_wav(wav, sample_rate_hz=22050)
    assert again == wav


def test_linear_pcm_to_wav_rejects_unaligned_payload():
    try:
        _linear_pcm_to_wav(b"\x00", sample_rate_hz=22050, sample_width=2)
    except RuntimeError as exc:
        assert "LINEAR_PCM" in str(exc)
    else:
        raise AssertionError("expected unaligned LINEAR_PCM to fail")
