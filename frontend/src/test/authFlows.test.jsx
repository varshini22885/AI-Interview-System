import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.jsx";
import ProtectedRoute from "../auth/ProtectedRoute.jsx";
import Login from "../pages/Login.jsx";
import HistoryPage from "../pages/HistoryPage.jsx";
import ResumePage from "../pages/ResumePage.jsx";

function jsonResponse(data, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function shell(initialEntries, routes) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("auth flow + protected routes + resume upload", () => {
  it("logs in and lands on the dashboard", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/auth/login")) return jsonResponse({ access_token: "tok", expires_in: 900 });
        if (u.endsWith("/auth/me")) return jsonResponse({ id: "u1", email: "dev@example.com", full_name: "Dev", is_active: true });
        if (u.includes("/resumes")) return jsonResponse({ items: [], page: 1, page_size: 50, total: 0 });
        return jsonResponse({}, { status: 404 });
      }),
    );
    shell(["/login"], <>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<div><h1>Dashboard</h1></div>} />
      <Route path="/resume" element={<ResumePage />} />
    </>);
    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^dashboard$/i })).toBeInTheDocument());
  });

  it("blocks unauthenticated access to protected pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/auth/refresh")) {
          return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "No." } }, { status: 401 });
        }
        return jsonResponse({ error: { code: "UNAUTHENTICATED", message: "No." } }, { status: 401 });
      }),
    );
    shell(["/history"], <>
      <Route path="/login" element={<Login />} />
      <Route path="/history" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
    </>);
    await waitFor(() => expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument());
  });

    it("validates resume file type client-side and uploads valid files", async () => {
    // applyAccept:false lets a non-matching .txt file reach the onChange
    // handler so the component's own validateFile() (client-side check) is
    // exercised here, rather than being silently filtered by user-event.
    const user = userEvent.setup({ applyAccept: false });
    const uploads = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/auth/refresh")) return jsonResponse({ access_token: "tok", expires_in: 900 });
        if (u.endsWith("/auth/me")) return jsonResponse({ id: "u1", email: "a@b.c", full_name: "A", is_active: true });
        if (u.includes("/resumes") && (init.method || "GET") === "POST") {
          uploads.push(true);
          return jsonResponse({ id: "r1", filename: "cv.pdf", content_type: "application/pdf", size_bytes: 10, created_at: new Date().toISOString() }, { status: 201 });
        }
        if (u.includes("/resumes")) return jsonResponse({ items: [], page: 1, page_size: 50, total: 0 });
        return jsonResponse({}, { status: 404 });
      }),
    );
    shell(["/resume"], <Route path="/resume" element={<ResumePage />} />);
    await waitFor(() => expect(screen.getByLabelText(/resume/i)).toBeInTheDocument());
    const input = screen.getByLabelText(/resume/i);
    const bad = new File(["x"], "notes.txt", { type: "text/plain" });
    await user.upload(input, bad);
    await waitFor(() => expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument());
    expect(uploads).toHaveLength(0);
    const good = new File(["pdf-bytes"], "cv.pdf", { type: "application/pdf" });
    await user.upload(input, good);
    await user.click(screen.getByRole("button", { name: /upload resume/i }));
    await waitFor(() => expect(uploads).toHaveLength(1));
  });

  it("keeps polling after upload until the worker marks the resume Ready", async () => {
    // Regression: POST /resumes persists status UPLOADED and the Celery worker
    // later moves the row to PROCESSING -> READY. Polling must therefore also
    // continue while the row is still UPLOADED, otherwise the "Ready" chip only
    // appears after a manual browser refresh (observed in the browser E2E run).
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/auth/refresh")) return jsonResponse({ access_token: "tok", expires_in: 900 });
        if (u.endsWith("/auth/me")) return jsonResponse({ id: "u1", email: "a@b.c", full_name: "Ada", is_active: true });
        if (u.includes("/resumes")) {
          listCalls += 1;
          const status = listCalls === 1 ? "UPLOADED" : "READY";
          return jsonResponse({
            items: [{ id: "r1", filename: "cv.pdf", status, created_at: "2026-04-01T00:00:00Z" }],
            page: 1,
            page_size: 20,
            total: 1,
          });
        }
        return jsonResponse({}, { status: 404 });
      }),
    );
    shell(["/resume"], <Route path="/resume" element={<ResumePage />} />);

    // The state the API actually persists on upload is rendered first ...
    await waitFor(() => expect(screen.getByText(/waiting to be processed/i)).toBeInTheDocument());
    const chip = () => document.querySelector(".resume-chip")?.textContent?.trim();
    expect(chip()).toBe("Uploaded");

    // ... and the 3s refetchInterval must flip the chip without any user action.
    await waitFor(() => expect(chip()).toBe("Ready"), { timeout: 8000 });
    expect(listCalls).toBeGreaterThan(1);
  }, 20000);
});
