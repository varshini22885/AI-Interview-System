import { describe, expect, it, vi } from "vitest";
import { ApiError, clearToken } from "../api/client.js";
import { jsonResponse } from "./helpers.js";

describe("API client error contract", () => {
  it("parses the backend envelope and preserves request_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "INTERVIEW_NOT_FOUND", message: "Not found.", request_id: "req-abc" } }, { status: 404 })),
    );
    const { api } = await import("../api/client.js");
    clearToken();
    try {
      await api.get("/interviews/missing");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(404);
      expect(err.code).toBe("INTERVIEW_NOT_FOUND");
      expect(err.requestId).toBe("req-abc");
    }
  });

  it("maps network failure to NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("boom");
      }),
    );
    const { api } = await import("../api/client.js");
    clearToken();
    await expect(api.get("/roles")).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("refreshes once then retries the original request", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/auth/refresh")) return jsonResponse({ access_token: "new", expires_in: 900 });
        if (calls.filter((u) => u.endsWith("/auth/me")).length === 1) {
          return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Expired." } }, { status: 401 });
        }
        return jsonResponse({ id: "u1", email: "a@b.c" });
      }),
    );
    const client = await import("../api/client.js");
    client.setToken("stale");
    const me = await client.api.get("/auth/me");
    expect(me.email).toBe("a@b.c");
    expect(calls.filter((u) => u.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("retries a transient refresh failure instead of ending the session", async () => {
    // Regression: in the browser E2E run the Vite dev proxy answered
    // POST /auth/refresh with 500 while its upstream socket blipped. The client
    // treated that as "session over" and logged the user out mid-interview.
    const calls = [];
    let refreshCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/auth/refresh")) {
          refreshCount += 1;
          if (refreshCount === 1) {
            return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Gateway blip." } }, { status: 500 });
          }
          return jsonResponse({ access_token: "fresh", expires_in: 900 });
        }
        if (calls.filter((u) => u.endsWith("/auth/me")).length === 1) {
          return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Expired." } }, { status: 401 });
        }
        return jsonResponse({ id: "u1", email: "a@b.c" });
      }),
    );
    const client = await import("../api/client.js");
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    client.setToken("stale");
    try {
      const me = await client.api.get("/auth/me");
      expect(me.email).toBe("a@b.c");
      expect(refreshCount).toBe(2);
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      client.setUnauthorizedHandler(null);
    }
  });

  it("keeps the session when the refresh endpoint is unavailable (5xx)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).endsWith("/auth/refresh")
          ? jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Upstream failed." } }, { status: 503 })
          : jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Expired." } }, { status: 401 }),
      ),
    );
    const client = await import("../api/client.js");
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    client.setToken("stale");
    try {
      await expect(client.api.get("/interviews/active")).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      client.setUnauthorizedHandler(null);
    }
  });

  it("ends the session when the refresh token is definitively rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).endsWith("/auth/refresh")
          ? jsonResponse({ error: { code: "INVALID_REFRESH", message: "Invalid refresh token" } }, { status: 401 })
          : jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Expired." } }, { status: 401 }),
      ),
    );
    const client = await import("../api/client.js");
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    client.setToken("stale");
    try {
      await expect(client.api.get("/interviews/active")).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      client.setUnauthorizedHandler(null);
    }
  });
});
