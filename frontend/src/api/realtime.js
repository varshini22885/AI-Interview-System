/**
 * Realtime interview transport (WebSocket).
 *
 * - `POST /interviews/{id}/realtime/session` creates (or reuses) the ACTIVE
 *   `RealtimeInterviewSession` and returns the server-owned `websocket_path`.
 * - The returned path is connected with the short-lived access token as the
 *   documented `access_token` query parameter: a browser WebSocket cannot send
 *   an Authorization header.
 * - Provider credentials never reach the browser.
 *
 * Contract: docs/frontend-integration-contract.md, docs/realtime-api.md
 */

import { api, getAccessToken } from "./client.js";

const DEFAULT_API_BASE = "/api/v1";

function configuredBaseUrl() {
  return import.meta.env?.VITE_API_BASE_URL || DEFAULT_API_BASE;
}

/** POST /interviews/{id}/realtime/session -> { session_id, interview_id, status, websocket_path } */
export function createRealtimeSession(interviewId) {
  return api.post(`/interviews/${interviewId}/realtime/session`);
}

/**
 * Resolve the server-provided websocket_path into an absolute ws:// URL.
 *
 * A relative VITE_API_BASE_URL (the dev proxy) stays on the page origin so the
 * connection keeps the same origin as the REST calls; an absolute base keeps
 * its own origin so deployed frontends can talk to a separate API host.
 * Query parameters already present on the path (session_id) are preserved.
 */
export function buildRealtimeSocketUrl(websocketPath, options = {}) {
  const {
    token = getAccessToken(),
    location = globalThis.location,
    baseUrl = configuredBaseUrl(),
  } = options;

  const path = String(websocketPath || "");
  const absoluteBase = /^https?:\/\//i.test(baseUrl) ? baseUrl : `${location.origin}/`;
  const url = new URL(path, absoluteBase);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("access_token", token);
  return url.toString();
}

/**
 * Compact, schema-valid client events. Unknown fields are rejected by the
 * backend, so every builder emits exactly the documented shape.
 */
export const clientEvents = {
  sessionStart: () => ({ type: "session_start" }),
  heartbeat: () => ({ type: "heartbeat" }),
  sessionEnd: () => ({ type: "session_end" }),
  audioStart: () => ({ type: "audio_start" }),
  audioChunk: (data) => ({ type: "audio_chunk", data }),
  audioEnd: () => ({ type: "audio_end" }),
  answerComplete: ({ questionId, transcript, idempotencyKey }) => ({
    type: "answer_complete",
    question_id: questionId,
    transcript,
    idempotency_key: idempotencyKey,
  }),
};
