/**
 * useRealtimeSession — the browser half of the realtime interview transport.
 *
 * Responsibilities (docs/realtime-api.md, docs/frontend-integration-contract.md):
 *   1. Create/reuse the ACTIVE realtime session over REST and open the returned
 *      WebSocket with the short-lived access token.
 *   2. Send `session_start`, periodic `heartbeat`, and mic `audio_start`/
 *      `audio_chunk` frames base64-encoded from MediaRecorder output.
 *   3. Replay the TTS question audio the server streams as `audio_started` +
 *      `audio_chunk` (text remains authoritative).
 *   4. Send compact `face_status` events from a REAL client-side detector only.
 *   5. Surface every capability the environment cannot provide instead of
 *      pretending it worked (STT provider unconfigured, TTS provider
 *      unconfigured, no face-detection model installed).
 *
 * Authoritative interview state is never held here: the REST interview status
 * remains the source of truth, and server events only invalidate queries.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { buildRealtimeSocketUrl, clientEvents, createRealtimeSession } from "../api/realtime.js";
import { getAccessToken, restoreSession } from "../api/client.js";
import { blobToBase64, pickRecorderMimeType } from "../lib/audioEncoding.js";
import { faceStatusEvent, isSamplableVideo, resolveFaceDetector } from "../lib/faceTelemetry.js";

const HEARTBEAT_INTERVAL_MS = 20000;
const FACE_SAMPLE_INTERVAL_MS = 1000;
const AUDIO_TIMESLICE_MS = 1000;
const SOCKET_OPEN = 1;
const SOCKET_CLOSE_NORMAL = 1000;

/** Audio MIME types the client knows how to frame for the transport. */
const AUDIO_MIME = { wav: "audio/wav", webm: "audio/webm", ogg: "audio/ogg" };

function decodeBase64Audio(data) {
  const binary = globalThis.atob(String(data));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Connect the realtime transport for one interview.
 *
 * @param {object} options
 * @param {string} options.interviewId
 * @param {boolean} options.enabled  only active interviews accept a session
 * @param {MediaStream|null} options.mediaStream  camera+mic stream from the page
 * @param {HTMLVideoElement|null} options.videoElement  preview used for face telemetry
 * @param {(event: object) => void} [options.onServerEvent]  server event sink
 */
export default function useRealtimeSession({ interviewId, enabled, mediaStream, videoElement, onServerEvent }) {
  const [connection, setConnection] = useState("idle"); // idle|connecting|live|closed|unavailable
  const [reason, setReason] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [tts, setTts] = useState({ status: "idle", reason: null }); // idle|played|unavailable
  const [stt, setStt] = useState({ status: "idle", reason: null }); // idle|streaming|unavailable
  const [face, setFace] = useState({ status: "idle", reason: null }); // idle|streaming|unavailable

  const socketRef = useRef(null);
  const audioElementRef = useRef(null);
  const audioAckRef = useRef(false);
  const ttsFormatRef = useRef("wav");
  const sttBlockedRef = useRef(false);
  const handlerRef = useRef(onServerEvent);
  handlerRef.current = onServerEvent;

  /** Send one strict JSON event; false when the socket is not open. */
  const send = useCallback((event) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Decode a base64 TTS payload and hand it to the browser's audio element. */
  const playQuestionAudio = useCallback((data, audioFormat) => {
    let url = null;
    try {
      const blob = new Blob([decodeBase64Audio(data)], { type: AUDIO_MIME[audioFormat] || "audio/wav" });
      url = URL.createObjectURL(blob);
      if (!audioElementRef.current) audioElementRef.current = new Audio();
      const audio = audioElementRef.current;
      const release = () => { try { URL.revokeObjectURL(url); } catch { /* already released */ } };
      audio.onended = release;
      audio.onerror = release;
      audio.src = url;
      const playback = audio.play();
      if (playback && typeof playback.catch === "function") playback.catch(() => { /* autoplay blocked: question text stays authoritative */ });
      setTts({ status: "played", reason: null });
    } catch {
      if (url) { try { URL.revokeObjectURL(url); } catch { /* already released */ } }
      setTts({ status: "unavailable", reason: "the browser could not decode the question audio" });
    }
  }, []);

  /** Route one server event; anything authoritative is only forwarded. */
  const handleServerMessage = useCallback((raw) => {
    let message = null;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "session_ack":
        if (message.session_id) setSessionId(message.session_id);
        break;
      case "audio_ack":
        if (message.event === "audio_start") audioAckRef.current = true;
        break;
      case "audio_started":
        ttsFormatRef.current = message.audio_format || "wav";
        setTts({ status: "playing", reason: null });
        break;
      case "audio_chunk":
        playQuestionAudio(message.data, message.audio_format || ttsFormatRef.current);
        break;
      case "error": {
        const code = String(message.code || "");
        if (code.startsWith("TTS_")) {
          setTts({ status: "unavailable", reason: `${code}: ${message.message || "text-to-speech is not configured"}` });
        } else if (code.startsWith("STT_")) {
          // The provider is not configured/enabled: stop feeding audio instead of
          // hammering the socket with chunks the server cannot consume.
          sttBlockedRef.current = true;
          setStt({ status: "unavailable", reason: `${code}: ${message.message || "speech recognition is not configured"}` });
        }
        break;
      }
      default:
        break;
    }
    if (typeof handlerRef.current === "function") handlerRef.current(message);
  }, [playQuestionAudio]);

  /* --- 1. Session + socket lifecycle ------------------------------------- */
  useEffect(() => {
    if (!interviewId || !enabled) {
      setConnection("idle");
      return undefined;
    }
    let cancelled = false;
    let socket = null;
    sttBlockedRef.current = false;
    audioAckRef.current = false;
    setConnection("connecting");
    setReason(null);

    (async () => {
      try {
        const session = await createRealtimeSession(interviewId);
        if (cancelled) return;
        if (!session?.websocket_path) {
          setConnection("unavailable");
          setReason("the server did not return a realtime websocket path");
          return;
        }
        setSessionId(session.session_id || null);

        let token = getAccessToken();
        if (!token) {
          // A hard reload keeps only the refresh cookie: rotate it before
          // connecting so reconnects after F5 work (contract "Reconnect").
          await restoreSession();
          token = getAccessToken();
        }
        if (cancelled) return;
        if (!token) {
          setConnection("unavailable");
          setReason("no access token available for the realtime transport");
          return;
        }

        socket = new WebSocket(buildRealtimeSocketUrl(session.websocket_path, { token }));
        socketRef.current = socket;
        socket.onopen = () => {
          if (cancelled) return;
          setConnection("live");
          send(clientEvents.sessionStart());
        };
        socket.onmessage = (event) => handleServerMessage(event.data);
        socket.onerror = () => {
          if (cancelled) return;
          setConnection("unavailable");
          setReason("the realtime socket reported an error");
        };
        socket.onclose = () => {
          if (cancelled) return;
          setConnection((current) => (current === "live" || current === "connecting" ? "closed" : current));
        };
      } catch (err) {
        if (cancelled) return;
        setConnection("unavailable");
        setReason(err?.message || "the realtime session could not be created");
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current = null;
      if (socket) {
        try {
          socket.close(SOCKET_CLOSE_NORMAL, "client_navigated");
        } catch {
          /* already closed */
        }
      }
    };
  }, [interviewId, enabled, handleServerMessage, send]);

  /* --- 2. Heartbeat ------------------------------------------------------ */
  useEffect(() => {
    if (connection !== "live") return undefined;
    const timer = setInterval(() => send(clientEvents.heartbeat()), HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connection, send]);

  /* --- 3. Microphone -> base64 audio frames ------------------------------ */
  useEffect(() => {
    if (connection !== "live" || !mediaStream || sttBlockedRef.current) return undefined;
    const track = mediaStream.getAudioTracks?.()[0];
    if (!track || track.readyState === "ended") return undefined;
    if (typeof globalThis.MediaRecorder === "undefined") {
      setStt({ status: "unavailable", reason: "this browser has no MediaRecorder, so microphone audio cannot be streamed" });
      return undefined;
    }

    let recorder = null;
    try {
      const mimeType = pickRecorderMimeType();
      recorder = new MediaRecorder(new MediaStream([track]), mimeType ? { mimeType } : undefined);
    } catch {
      setStt({ status: "unavailable", reason: "the browser refused to record the microphone track" });
      return undefined;
    }

    recorder.ondataavailable = async (event) => {
      if (sttBlockedRef.current || !event?.data) return;
      try {
        const data = await blobToBase64(event.data);
        if (!data) return;
        send(clientEvents.audioChunk(data));
      } catch {
        /* one unencodable chunk must not tear down a live session */
      }
    };

    send(clientEvents.audioStart());
    try {
      recorder.start(AUDIO_TIMESLICE_MS);
      setStt({ status: "streaming", reason: null });
    } catch {
      setStt({ status: "unavailable", reason: "the browser could not start microphone recording" });
      return undefined;
    }

    // Stop feeding audio the moment the document goes away (reload/navigation) so
    // the recorder and the microphone device are released immediately.
    const stopRecording = () => {
      sttBlockedRef.current = true;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
    };
    window.addEventListener("pagehide", stopRecording);

    return () => {
      window.removeEventListener("pagehide", stopRecording);
      const wasStreaming = audioAckRef.current;
      stopRecording();
      // `audio_end` finalizes the transcript and submits it as an answer, so it
      // is only sent when the server actually acknowledged the stream.
      // Otherwise (unconfigured STT) the segment is dropped rather than
      // submitting an answer the candidate never confirmed.
      if (wasStreaming) send(clientEvents.audioEnd());
    };
  }, [connection, mediaStream, send]);

  /* --- 4. Face telemetry (real detector only) ---------------------------- */
  useEffect(() => {
    if (connection !== "live" || !mediaStream) return undefined;
    const detector = resolveFaceDetector();
    if (!detector) {
      setFace({
        status: "unavailable",
        reason: "no client-side face detector is installed (this browser exposes no Shape Detection API)",
      });
      return undefined;
    }
    setFace({ status: "streaming", reason: null });
    const timer = setInterval(async () => {
      if (!isSamplableVideo(videoElement)) return;
      try {
        send(faceStatusEvent(await detector.detect(videoElement)));
      } catch {
        setFace({ status: "unavailable", reason: "face detection failed in this browser" });
      }
    }, FACE_SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connection, mediaStream, videoElement, send]);

  return { connection, reason, sessionId, tts, stt, face, send };
}

/** One-line, user-visible summary of the realtime capabilities. */
export function realtimeSummary({ connection, tts, stt, face }) {
  const connectionLabel =
    connection === "live" ? "Realtime connected"
      : connection === "connecting" ? "Realtime connecting…"
        : connection === "closed" ? "Realtime disconnected"
          : connection === "unavailable" ? "Realtime unavailable"
            : "Realtime idle";
  const sttLabel = stt?.status === "streaming" ? "mic streaming to ASR"
    : stt?.status === "unavailable" ? "mic streaming unavailable" : "mic idle";
  const ttsLabel = tts?.status === "played" || tts?.status === "playing" ? "question audio playing"
    : tts?.status === "unavailable" ? "question audio unavailable" : "no question audio";
  const faceLabel = face?.status === "streaming" ? "face telemetry on"
    : face?.status === "unavailable" ? "face telemetry unavailable" : "face telemetry idle";
  return `${connectionLabel} · ${sttLabel} · ${ttsLabel} · ${faceLabel}`;
}
