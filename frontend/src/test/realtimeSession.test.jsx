/**
 * Realtime transport tests.
 *
 * Every capability claim is checked against observable behaviour: session
 * creation, the authenticated socket, microphone frames, TTS replay, and the
 * honest "unavailable" reporting when the environment provides no STT/face
 * detection. No test asserts a capability the browser does not have.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken, setToken } from "../api/client.js";
import { buildRealtimeSocketUrl, clientEvents } from "../api/realtime.js";
import useRealtimeSession, { realtimeSummary } from "../hooks/useRealtimeSession.js";
import { blobToBase64, pickRecorderMimeType } from "../lib/audioEncoding.js";
import { faceStatusEvent, resolveFaceDetector } from "../lib/faceTelemetry.js";
import { jsonResponse } from "./helpers.js";

const INTERVIEW_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "99999999-8888-4777-8666-555555555555";
const WEBSOCKET_PATH = `/api/v1/interviews/${INTERVIEW_ID}/realtime/ws?session_id=${SESSION_ID}`;
const QUESTION_ID = "22222222-3333-4444-8555-666666666666";

/* ------------------------------ test doubles ------------------------------ */

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCode = null;
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close(code) {
    this.closeCode = code;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  types() {
    return this.sent.map((event) => event.type);
  }
}

class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported = (type) => type === "audio/webm;codecs=opus";
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || "";
    this.state = "inactive";
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
  }

  emit(data) {
    return this.ondataavailable?.({ data });
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

const audioElements = [];

class FakeAudio {
  constructor() {
    this.src = "";
    this.playCalled = false;
    audioElements.push(this);
  }

  play() {
    this.playCalled = true;
    return Promise.resolve();
  }
}

function liveStream() {
  return new FakeMediaStream([
    { kind: "audio", readyState: "live", enabled: true, label: "fake-mic" },
    { kind: "video", readyState: "live", enabled: true, label: "fake-cam" },
  ]);
}

function stubSessionEndpoint() {
  const mock = vi.fn(async (url, init = {}) => {
    if (String(url).endsWith(`/interviews/${INTERVIEW_ID}/realtime/session`) && (init.method || "POST") === "POST") {
      return jsonResponse({ session_id: SESSION_ID, interview_id: INTERVIEW_ID, status: "ACTIVE", websocket_path: WEBSOCKET_PATH });
    }
    return jsonResponse({}, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeMediaRecorder.instances = [];
  audioElements.length = 0;
  setToken("test-token");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("Audio", FakeAudio);
  if (!URL.createObjectURL) URL.createObjectURL = () => "blob:test";
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
  stubSessionEndpoint();
});

afterEach(() => {
  clearToken();
  delete globalThis.__aiInterviewFaceDetector;
  vi.useRealTimers();
});


/* --------------------------------- tests ---------------------------------- */

describe("realtime socket URL", () => {
  it("keeps the session id, adds the access token and upgrades to wss on https", () => {
    const url = buildRealtimeSocketUrl(WEBSOCKET_PATH, {
      token: "abc",
      location: { origin: "https://app.example.com", protocol: "https:" },
      baseUrl: "/api/v1",
    });
    expect(url).toBe(`wss://app.example.com${WEBSOCKET_PATH}&access_token=abc`);
  });

  it("resolves a relative base against the page origin so the dev proxy stays same-origin", () => {
    const url = buildRealtimeSocketUrl(WEBSOCKET_PATH, {
      token: "abc",
      location: { origin: "http://127.0.0.1:5173", protocol: "http:" },
      baseUrl: "/api/v1",
    });
    expect(url.startsWith(`ws://127.0.0.1:5173/api/v1/interviews/${INTERVIEW_ID}/realtime/ws`)).toBe(true);
  });

  it("keeps the API host when VITE_API_BASE_URL is absolute", () => {
    const url = buildRealtimeSocketUrl(WEBSOCKET_PATH, {
      token: "abc",
      location: { origin: "https://app.example.com", protocol: "https:" },
      baseUrl: "https://api.example.com/api/v1",
    });
    expect(url.startsWith(`wss://api.example.com/api/v1/interviews/${INTERVIEW_ID}/realtime/ws`)).toBe(true);
  });

  it("builds exactly the documented client event shapes", () => {
    expect(clientEvents.sessionStart()).toEqual({ type: "session_start" });
    expect(clientEvents.heartbeat()).toEqual({ type: "heartbeat" });
    expect(clientEvents.audioStart()).toEqual({ type: "audio_start" });
    expect(clientEvents.audioChunk("AAA")).toEqual({ type: "audio_chunk", data: "AAA" });
    expect(clientEvents.audioEnd()).toEqual({ type: "audio_end" });
    expect(clientEvents.answerComplete({ questionId: QUESTION_ID, transcript: "hi", idempotencyKey: "k-12345678" })).toEqual({
      type: "answer_complete",
      question_id: QUESTION_ID,
      transcript: "hi",
      idempotency_key: "k-12345678",
    });
  });
});


describe("realtime environment reporting helpers", () => {
  it("sends compact face_status events only (no frames, at most two faces)", () => {
    const event = faceStatusEvent([{ boundingBox: {} }, { boundingBox: {} }, { boundingBox: {} }], { timestamp: "2026-09-28T00:00:00.000Z" });
    expect(event).toEqual({ type: "face_status", timestamp: "2026-09-28T00:00:00.000Z", face_present: true, face_count: 2 });
    expect(faceStatusEvent([]).face_present).toBe(false);
  });

  it("reports no detector instead of assuming a face", () => {
    expect(resolveFaceDetector({})).toBeNull();
    const injected = { detect: () => [{}, {}] };
    expect(resolveFaceDetector({ __aiInterviewFaceDetector: injected })?.kind).toBe("injected");
  });

  it("base64-encodes MediaRecorder chunks and picks a backend-compatible mime type", async () => {
    const encoded = await blobToBase64(new Blob(["chunk-1"]));
    expect(globalThis.atob(encoded)).toBe("chunk-1");
    expect(await blobToBase64(new Blob([]))).toBe("");
    expect(pickRecorderMimeType({ MediaRecorder: FakeMediaRecorder })).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMimeType({})).toBe("");
  });

  it("summarises capability state for the UI", () => {
    const summary = realtimeSummary({
      connection: "live",
      tts: { status: "unavailable" },
      stt: { status: "streaming" },
      face: { status: "unavailable" },
    });
    expect(summary).toBe("Realtime connected · mic streaming to ASR · question audio unavailable · face telemetry unavailable");
  });
});

describe("useRealtimeSession", () => {
  it("creates the realtime session, connects with the token and sends session_start", async () => {
    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain(`/api/v1/interviews/${INTERVIEW_ID}/realtime/ws?session_id=${SESSION_ID}`);
    expect(socket.url).toContain("access_token=test-token");
    expect(socket.url.startsWith("ws://")).toBe(true);

    act(() => socket.open());
    await waitFor(() => expect(result.current.connection).toBe("live"));
    expect(socket.types()).toContain("session_start");
    expect(result.current.sessionId).toBe(SESSION_ID);
  });

  it("forwards question_started to the page without inventing state", async () => {
    const onServerEvent = vi.fn();
    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent };
    const { result } = renderHook(() => useRealtimeSession(props));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.connection).toBe("live"));

    act(() => socket.receive({ type: "question_started", question_id: QUESTION_ID, text: "Explain event loops.", status: "WAITING_FOR_ANSWER" }));
    expect(onServerEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "question_started", question_id: QUESTION_ID }));
    expect(result.current.connection).toBe("live");
  });

  it("does not connect while the interview is not active", () => {
    const props = { interviewId: INTERVIEW_ID, enabled: false, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));
    expect(result.current.connection).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("streams the microphone as base64 audio frames and backs off when ASR is unconfigured", async () => {
    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));

    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder.mimeType).toBe("audio/webm;codecs=opus");
    expect(socket.types()).toContain("audio_start");
    await waitFor(() => expect(result.current.stt.status).toBe("streaming"));

    await act(async () => {
      await recorder.emit(new Blob(["chunk-1"]));
    });
    await waitFor(() => expect(socket.sent.filter((event) => event.type === "audio_chunk")).toHaveLength(1));
    const chunk = socket.sent.find((event) => event.type === "audio_chunk");
    expect(globalThis.atob(chunk.data)).toBe("chunk-1");

    // The server refuses the stream because no ASR provider is configured.
    act(() => socket.receive({ type: "error", code: "STT_NOT_CONFIGURED", message: "Speech recognition is unavailable." }));
    await waitFor(() => expect(result.current.stt.status).toBe("unavailable"));
    expect(result.current.stt.reason).toContain("STT_NOT_CONFIGURED");

    const before = socket.sent.filter((event) => event.type === "audio_chunk").length;
    await act(async () => {
      await recorder.emit(new Blob(["chunk-2"]));
    });
    expect(socket.sent.filter((event) => event.type === "audio_chunk")).toHaveLength(before);
  });

  it("replays the question audio the server streams and names the TTS gap when none arrives", async () => {
    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.connection).toBe("live"));

    act(() => socket.receive({ type: "audio_started", audio_format: "wav" }));
    expect(result.current.tts.status).toBe("playing");

    act(() => socket.receive({ type: "audio_chunk", data: "d2F2", audio_format: "wav" }));
    await waitFor(() => expect(audioElements).toHaveLength(1));
    expect(audioElements[0].src.startsWith("blob:")).toBe(true);
    expect(audioElements[0].playCalled).toBe(true);
    expect(result.current.tts.status).toBe("played");

    act(() => socket.receive({ type: "error", code: "TTS_UNAVAILABLE", message: "Question speech is unavailable." }));
    await waitFor(() => expect(result.current.tts.status).toBe("unavailable"));
    expect(result.current.tts.reason).toContain("TTS_UNAVAILABLE");
  });


  it("reports unavailability instead of a silent failure when the session cannot be created", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "INTERVIEW_NOT_ACTIVE", message: "Interview is not active." } }, { status: 409 })));
    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));
    await waitFor(() => expect(result.current.connection).toBe("unavailable"));
    expect(result.current.reason).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("reports that face telemetry is unavailable instead of inventing a face", async () => {
    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.face.status).toBe("unavailable"));
    expect(result.current.face.reason).toMatch(/face detector/i);
    expect(socket.types()).not.toContain("face_status");
  });

  it("streams compact face_status events when a real detector is installed", async () => {
    globalThis.__aiInterviewFaceDetector = { detect: async () => [{}, {}, {}] };
    const video = document.createElement("video");
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });

    const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: video, onServerEvent: vi.fn() };
    const { result } = renderHook(() => useRealtimeSession(props));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    await waitFor(() => expect(result.current.face.status).toBe("streaming"));

    await waitFor(() => expect(socket.types()).toContain("face_status"), { timeout: 5000 });
    const frame = socket.sent.find((event) => event.type === "face_status");
    expect(frame.face_present).toBe(true);
    expect(frame.face_count).toBe(2);
    expect(Object.keys(frame).sort()).toEqual(["face_count", "face_present", "timestamp", "type"]);
  });

  it("keeps the session alive with heartbeats", async () => {
    vi.useFakeTimers();
    try {
      const props = { interviewId: INTERVIEW_ID, enabled: true, mediaStream: liveStream(), videoElement: null, onServerEvent: vi.fn() };
      const { result } = renderHook(() => useRealtimeSession(props));

      for (let i = 0; i < 5 && FakeWebSocket.instances.length === 0; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
      }
      const socket = FakeWebSocket.instances[0];
      expect(socket).toBeTruthy();
      act(() => socket.open());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(result.current.connection).toBe("live");
      expect(socket.types()).toContain("session_start");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });
      expect(socket.types()).toContain("heartbeat");
    } finally {
      vi.useRealTimers();
    }
  });

});
