import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.jsx";
import Home from "../pages/Home.jsx";
import SetupPage from "../pages/SetupPage.jsx";
import InsightsPage from "../pages/InsightsPage.jsx";
import LobbyPage from "../pages/LobbyPage.jsx";
import HistoryPage from "../pages/HistoryPage.jsx";

const interviewId = "11111111-2222-4333-8444-555555555555";

function jsonResponse(data, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: "OK", headers: new Headers(), json: async () => data, text: async () => JSON.stringify(data) };
}

function stubBackend(scenario) {
  const mock = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/refresh")) return jsonResponse({ access_token: "tok", expires_in: 900 });
    if (u.endsWith("/auth/me")) return jsonResponse({ id: "u1", email: "a@b.c", full_name: "Ada", is_active: true });
    return scenario(u, init.method || "GET", init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderWorkspace(initialEntries, extraRoutes = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/lobby/:interviewId" element={<LobbyPage />} />
            {extraRoutes}
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const HISTORY_ITEMS = [
  { id: "i-80", status: "REPORT_READY", target_role: "Backend Developer", interview_type: "TECHNICAL", difficulty: "MEDIUM", total_questions: 10, completed_at: "2026-05-02T10:00:00Z", overall_score: 80 },
  { id: "i-60", status: "COMPLETED", target_role: "Data Analyst", interview_type: "BEHAVIORAL", difficulty: "EASY", total_questions: 5, completed_at: "2026-05-01T10:00:00Z", overall_score: 60 },
];

describe("workspace sidebar, dashboard, insights and 5-step setup", () => {
  it("keeps the sidebar on Dashboard, toggles it with the hamburger and routes Insights separately", async () => {
    const user = userEvent.setup();
    stubBackend((u) => {
      if (u.includes("/history")) return jsonResponse({ items: HISTORY_ITEMS, page: 1, page_size: 50, total: 2 });
      if (u.includes("/resumes")) return jsonResponse({ items: [], page: 1, page_size: 1, total: 0 });
      return jsonResponse({}, { status: 404 });
    });
    renderWorkspace(["/"]);

    const dashboardNav = await screen.findByRole("button", { name: "Dashboard" });
    const sidebar = document.getElementById("workspace-sidebar");
    expect(sidebar).toBeInTheDocument();
    expect(dashboardNav).toHaveAttribute("aria-current", "page");

    const toggle = document.querySelector(".menu-toggle");
    expect(toggle).toBeTruthy();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(sidebar.className).toContain("is-collapsed");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(sidebar.className).not.toContain("is-collapsed");

    // Insights is its own route, not an alias of History.
    await user.click(within(sidebar).getByRole("button", { name: "Insights" }));
    expect(await screen.findByRole("heading", { name: "Performance Over Time" })).toBeInTheDocument();
    expect(within(document.getElementById("workspace-sidebar")).getByRole("button", { name: "Insights" })).toHaveAttribute("aria-current", "page");
  });
  it("removes Quick Actions and shows recent interviews as the only dashboard panel", async () => {
    stubBackend((u) => {
      if (u.includes("/history")) return jsonResponse({ items: HISTORY_ITEMS, page: 1, page_size: 50, total: 2 });
      if (u.includes("/resumes")) return jsonResponse({ items: [{ id: "r1", filename: "cv.pdf", status: "READY", created_at: "2026-04-01T00:00:00Z" }], page: 1, page_size: 1, total: 1 });
      return jsonResponse({}, { status: 404 });
    });
    renderWorkspace(["/"]);

    expect(await screen.findByText("Backend Developer")).toBeInTheDocument();
    expect(screen.queryByText(/quick actions/i)).not.toBeInTheDocument();
    // Performance snapshot card removed � no Performance heading on the dashboard.
    expect(screen.queryByRole("heading", { name: "Performance" })).not.toBeInTheDocument();
    // Recent interviews panel remains with its View all link.
    expect(screen.getByRole("button", { name: /View all/ })).toBeInTheDocument();
  });

  it("renders insights analytics that History does not show", async () => {
    stubBackend((u) => {
      if (u.includes("/history")) return jsonResponse({ items: HISTORY_ITEMS, page: 1, page_size: 100, total: 2 });
      if (u.endsWith(`/reports/i-80`)) return jsonResponse({ interview_id: "i-80", status: "REPORT_READY", technical_score: 90, communication_score: 55, overall_score: 80, total_questions_answered: 10, strengths: "Clear API design", areas_for_improvement: "Trim the rambling" });
      return jsonResponse({}, { status: 404 });
    });
    renderWorkspace(["/insights"]);

    expect(await screen.findByRole("heading", { name: "Performance Over Time" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Technical vs Communication" })).toBeInTheDocument();
    expect(await screen.findByText("Clear API design")).toBeInTheDocument();
    expect(screen.getByText("Trim the rambling")).toBeInTheDocument();
    // A record list belongs to History, not Insights.
    expect(screen.queryByText("Date & Time")).not.toBeInTheDocument();
  });

  it("keeps the lobby failure honest and offers retry plus back to setup", async () => {
    const user = userEvent.setup();
    let statusCalls = 0;
    stubBackend((u) => {
      if (u.endsWith(`/interviews/${interviewId}`)) {
        statusCalls += 1;
        return jsonResponse({ id: interviewId, status: "FAILED", target_role: "Backend Developer", interview_type: "TECHNICAL", difficulty: "MEDIUM", interviewer_persona: "PROFESSIONAL", total_questions: 5, current_question_index: 0, created_at: new Date().toISOString() });
      }
      return jsonResponse({}, { status: 404 });
    });
    renderWorkspace([`/lobby/${interviewId}`]);

    expect(await screen.findByRole("heading", { name: "Preparation Failed" })).toBeInTheDocument();
    expect(screen.getByText(/reported this session as failed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Setup" })).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Retry" });
    await user.click(retry);
    await waitFor(() => expect(statusCalls).toBeGreaterThan(1));
    // Still FAILED on the server => still no way to "enter" a broken interview.
    expect(screen.queryByRole("button", { name: /enter interview/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preparation Failed" })).toBeInTheDocument();
  });
});
describe("interview setup is exactly five working steps", () => {
  it("validates each step, carries a custom role and language into the create payload", async () => {
    const user = userEvent.setup();
    const posts = [];
    stubBackend((u, method, init) => {
      if (u.includes("/roles")) {
        return jsonResponse({ items: [{ role: "Backend Developer", interview_types: ["TECHNICAL", "MIXED"], difficulties: ["EASY", "MEDIUM"], languages: ["Python"] }] });
      }
      if (u.includes("/resumes")) {
        return jsonResponse({ items: [{ id: "r1", filename: "cv.pdf", status: "READY", created_at: "2026-04-01T00:00:00Z" }], page: 1, page_size: 50, total: 1 });
      }
      if (u.endsWith("/interviews") && method === "POST") {
        posts.push(JSON.parse(init.body));
        return jsonResponse({ id: "i-new", status: "PREPARING" }, { status: 201 });
      }
      if (u.endsWith("/interviews/i-new")) {
        return jsonResponse({ id: "i-new", status: "PREPARING", target_role: "Robotics Engineer", interview_type: "TECHNICAL", difficulty: "EASY", interviewer_persona: "PROFESSIONAL", total_questions: 10, current_question_index: 0, created_at: new Date().toISOString() });
      }
      return jsonResponse({}, { status: 404 });
    });
    renderWorkspace(["/setup"]);

    // Exactly five steps, in the required order.
    ["Resume", "Role", "Interview Type", "Settings", "Review"].forEach((label) => {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    });
    expect(screen.getByText("Step 1 of 5 · Resume")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Choose a Resume" })).toBeInTheDocument();

    // Step 1 — resume selection is real state.
    const resumeCard = await screen.findByRole("button", { name: /cv\.pdf/i });
    await user.click(resumeCard);
    expect(resumeCard).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Next →" }));

    // Step 2 — Next is blocked until a valid role exists, and Back works.
    expect(screen.getByRole("heading", { name: "Select Role" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next →" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByRole("heading", { name: "Choose a Resume" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next →" }));

    // A suggested role narrows the advertised interview types.
    await user.click(await screen.findByRole("button", { name: /Backend Developer/ }));
    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.getByRole("heading", { name: "Choose Interview Type" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Technical/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Behavioral/ })).not.toBeInTheDocument();

    // Going back and typing a custom role unlocks the full type set, and the
    // custom role itself is what the create payload must carry.
    await user.click(screen.getByRole("button", { name: "← Back" }));
    await user.type(screen.getByLabelText("Custom role"), "Robotics Engineer");
    expect(screen.getByRole("button", { name: "Next →" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Next →" }));

    expect(screen.getByRole("heading", { name: "Choose Interview Type" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Technical/ }));
    await user.click(screen.getByRole("button", { name: "Next →" }));

    // Step 4 — settings accept a custom programming language.
    expect(screen.getByRole("heading", { name: "Interview Settings" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Programming language"), "Rust");
    await user.click(screen.getByRole("button", { name: "Next →" }));

    // Step 5 — review summarises every choice before submission.
    expect(screen.getByRole("heading", { name: "Review Your Interview" })).toBeInTheDocument();
    expect(screen.getByText("Robotics Engineer")).toBeInTheDocument();
    expect(screen.getByText("cv.pdf")).toBeInTheDocument();
    expect(screen.getByText("Rust")).toBeInTheDocument();
    expect(screen.getByText("10 questions")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start Interview →" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      resume_id: "r1",
      target_role: "Robotics Engineer",
      programming_language: "Rust",
      interview_type: "TECHNICAL",
      question_count: 10,
    });
    // Final submission hands off to the real lobby route.
    expect(await screen.findByText(/preparing your interview/i)).toBeInTheDocument();
  });
});

