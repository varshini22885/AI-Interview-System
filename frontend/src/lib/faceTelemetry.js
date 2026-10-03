/**
 * Client-side face telemetry.
 *
 * Privacy rule (docs/realtime-api.md): camera processing stays in the browser;
 * only compact `face_status` events (presence/count, optional head pose) are
 * sent, never frames.
 *
 * A face presence/count claim must come from a real detector, so this module
 * reports telemetry only when one exists:
 *
 *   1. `window.__aiInterviewFaceDetector` — a detector adapter the host
 *      deployment may install (e.g. a bundled MediaPipe/face-api model) exposing
 *      `detect(videoElement) -> Array<unknown>` (async or sync).
 *   2. `window.FaceDetector` — the browser Shape Detection API.
 *
 * When neither exists, `resolveFaceDetector` returns `null` and the caller must
 * surface "face telemetry unavailable" instead of inventing a face.
 */

/** Detector kinds, most specific first. */
export function resolveFaceDetector(scope = globalThis) {
  const injected = scope?.__aiInterviewFaceDetector;
  if (injected && typeof injected.detect === "function") {
    return {
      kind: "injected",
      detect: async (videoElement) => {
        const faces = await injected.detect(videoElement);
        return Array.isArray(faces) ? faces : [];
      },
    };
  }

  const Detector = scope?.FaceDetector;
  if (typeof Detector === "function") {
    let instance = null;
    return {
      kind: "FaceDetector",
      detect: async (videoElement) => {
        if (!instance) instance = new Detector({ fastMode: true, maxDetectedFaces: 2 });
        const faces = await instance.detect(videoElement);
        return Array.isArray(faces) ? faces : [];
      },
    };
  }

  return null;
}

/** A detector can only run against a video element that is actually showing frames. */
export function isSamplableVideo(videoElement) {
  return Boolean(videoElement) && videoElement.readyState >= 2;
}

/**
 * Build the strict `face_status` event. Extra detector output (bounding boxes,
 * landmarks, confidence) is intentionally dropped: the backend rejects unknown
 * fields and never receives image data.
 */
export function faceStatusEvent(faces, { timestamp = new Date().toISOString() } = {}) {
  const list = Array.isArray(faces) ? faces.slice(0, 2) : [];
  return {
    type: "face_status",
    timestamp,
    face_present: list.length > 0,
    face_count: list.length,
  };
}
