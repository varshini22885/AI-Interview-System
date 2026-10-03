/**
 * Audio encoding helpers for the realtime transport.
 *
 * The backend accepts base64 `audio_chunk` payloads only (`docs/realtime-api.md`),
 * so raw MediaRecorder blobs are base64-encoded in the browser and never stored.
 */

/** MediaRecorder mimeTypes the backend expects (webm/opus container framing). */
export function pickRecorderMimeType(scope = globalThis) {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  const Recorder = scope?.MediaRecorder;
  if (!Recorder || typeof Recorder.isTypeSupported !== "function") return "";
  return candidates.find((type) => Recorder.isTypeSupported(type)) || "";
}

/**
 * base64-encode a Blob/ArrayBuffer using FileReader (available in browsers and
 * jsdom). Returns "" for empty input so callers can skip empty chunks.
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob || (typeof blob.size === "number" && blob.size === 0)) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to encode audio chunk"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}
