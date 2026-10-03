/**
 * Centralized HTTP client.
 * - Base URL from environment (VITE_API_BASE_URL), never hardcoded.
 * - Maps backend error envelope { error: { code, message, request_id } } to ApiError.
 * - Access token lives in memory ONLY. Refresh token stays in the backend's
 *   HttpOnly cookie; the JSON refresh_token field is intentionally discarded.
 * - 401 => single-flight refresh => one retry of the original request.
 * - Only a *definitive* refresh rejection (401/403 from /auth/refresh) ends the
 *   session; a transient failure (network error / 5xx) is retried once and must
 *   never log the user out in the middle of an interview.
 * - Never logs tokens, resume contents, or answers.
 */

const BASE_URL = import.meta.env?.VITE_API_BASE_URL || "/api/v1";

export class ApiError extends Error {
  constructor(status, code, message, requestId = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

let accessToken = null;
let refreshInFlight = null;
let unauthorizedHandler = null;

export function setToken(token) {
  accessToken = token || null;
}

export function clearToken() {
  accessToken = null;
}

/**
 * Read-only view of the in-memory access token.
 *
 * The browser WebSocket API cannot send an Authorization header, so the
 * realtime transport authenticates with the documented `access_token` query
 * parameter and needs the current token. The value is never logged.
 */
export function getAccessToken() {
  return accessToken;
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
}

function notifyUnauthorized() {
  clearToken();
  if (unauthorizedHandler) unauthorizedHandler();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function toApiError(body, status) {
  const envelope = body && body.error ? body.error : null;
  return new ApiError(
    status,
    envelope?.code || `HTTP_${status}`,
    envelope?.message || "Request failed.",
    envelope?.request_id || null,
  );
}

/**
 * A refresh failure is "transient" when the session was not actually rejected:
 * the request never reached the backend (network error) or the backend/gateway
 * could not answer (5xx). Observed in the browser E2E run: the Vite dev proxy
 * returns 500 when its upstream socket blips mid-interview, which must not be
 * mistaken for an expired session.
 */
function isTransientRefreshFailure(status) {
  return status === 0 || status === 429 || status >= 500;
}

/** Statuses that mean the refresh cookie itself was rejected (session is over). */
function isDefinitiveAuthFailure(status) {
  return status === 401 || status === 403;
}

const REFRESH_RETRY_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rotate the refresh cookie into a new in-memory access token (single-flight,
 * one retry on transient infrastructure failures).
 * @returns {Promise<{ok: boolean, transient: boolean, status: number}>} `ok` = a fresh
 * access token is in memory; `transient` = the outcome is unknown (do NOT end the session).
 */
async function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      let status = 0;
      try {
        const response = await fetch(`${BASE_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        status = response.status;
        if (response.ok) {
          const data = await response.json();
          // data.refresh_token is intentionally NOT stored or logged.
          accessToken = data.access_token || null;
          return { ok: Boolean(accessToken), transient: false, status };
        }
      } catch {
        status = 0;
      }
      if (attempt === 0 && isTransientRefreshFailure(status)) {
        await sleep(REFRESH_RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, transient: isTransientRefreshFailure(status), status };
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** Try to rotate the refresh cookie into a new in-memory access token. */
async function tryRefresh() {
  const result = await refreshSession();
  return result.ok;
}

/** Restore a session from the refresh cookie (used on app boot). */
export async function restoreSession() {
  return tryRefresh();
}

const AUTH_BYPASS = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"];

async function request(path, { method = "GET", body, formData, headers = {}, retry = true } = {}) {
  const requestHeaders = { ...headers };
  if (accessToken) requestHeaders.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      credentials: "include",
      body: formData ? formData : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
  }

  if (response.status === 401 && retry && !AUTH_BYPASS.some((p) => path.startsWith(p))) {
    const refreshed = await refreshSession();
    if (refreshed.ok) {
      return request(path, { method, body, formData, headers, retry: false });
    }
    // Only a definitive rejection (401/403) means the session is over. A transient
    // failure (network error / 5xx / 429) leaves the refresh cookie untouched, so
    // the session is preserved instead of logging the user out mid-interview.
    if (isDefinitiveAuthFailure(refreshed.status)) notifyUnauthorized();
  }

  if (!response.ok) {
    throw toApiError(await safeJson(response), response.status);
  }
  if (response.status === 204) return null;
  return safeJson(response);
}

export const api = {
  get: (path) => request(path),
  post: (path, body, options = {}) => request(path, { method: "POST", body, ...options }),
  postForm: (path, formData) => request(path, { method: "POST", formData }),
  del: (path) => request(path, { method: "DELETE" }),
};
