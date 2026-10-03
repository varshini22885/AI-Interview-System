import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { currentPayload, interviewId, jsonResponse, renderInterview, stubBackend } from "./interviewA.test.jsx";

describe("interview async states", () => {
  it("blocks double-click from minting two submissions", async () => {
    const user = userEvent.setup();
    let posts = 0;
    stubBackend((u) => {
      if (u.endsWith(`/interviews/${interviewId}`)) {
        return jsonResponse({ id: interviewId, status: "WAITING_FOR_ANSWER", started_at: new Date().toISOString() });
      }
      if (u.endsWith(`/interviews/${interviewId}/current`)) return jsonResponse(currentPayload());
      if (u.endsWith(`/interviews/${interviewId}/transcript`)) return jsonResponse([]);
      if (u.endsWith(`/interviews/${interviewId}/answers`)) {
        posts += 1;
        return jsonResponse({ answer_id: "a-1", attempt_number: 1, status: "EVALUATING", is_duplicate: false, accepted: true }, { status: 202 });
      }
      return jsonResponse({}, { status: 404 });
    });
    renderInterview();
    await screen.findByText("Explain event loops.");
    await user.type(screen.getByLabelText(/your answer/i), "Answer text here.");
    const button = screen.getByRole("button", { name: /send answer/i });
    await user.click(button);
    await user.click(button).catch(() => {});
    await waitFor(() => expect(posts).toBe(1));
  });

  it("shows EVALUATING honestly then the backend follow-up", async () => {
    let currentCalls = 0;
    stubBackend((u) => {
      if (u.endsWith(`/interviews/${interviewId}`)) return jsonResponse({ id: interviewId, status: "EVALUATING" });
      if (u.endsWith(`/interviews/${interviewId}/current`)) {
        currentCalls += 1;
        if (currentCalls === 1) return jsonResponse(currentPayload({ status: "EVALUATING", answer_allowed: false }));
        return jsonResponse(currentPayload({ status: "FOLLOW_UP_REQUIRED", follow_up: { follow_up_id: "f-1", follow_up_text: "What blocks it?", reason: "missing concept", target_concept: "blocking", difficulty: "MEDIUM" } }));
      }
      if (u.endsWith(`/interviews/${interviewId}/transcript`)) return jsonResponse([]);
      return jsonResponse({}, { status: 404 });
    });
    renderInterview();
    expect(await screen.findByText(/evaluating your answer/i)).toBeInTheDocument();
    // Bounded polling converges on the authoritative FOLLOW_UP_REQUIRED state.
    expect(await screen.findByText("What blocks it?", {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.queryByText(/\/10/)).not.toBeInTheDocument();
  });

  it("binds an early camera stream to the preview once the interview data arrives", async () => {
    // Regression: the stream is acquired on mount, but the interview markup
    // (including <video>) only mounts after the interview query resolves. On a
    // cold load the stream therefore exists before the element; the page must
    // still bind it, otherwise the preview stays blank while the UI says
    // "Camera On" (observed on refresh in the browser E2E run).
    const stream = { getTracks: () => [{ kind: "video", stop() {} }, { kind: "audio", stop() {} }] };
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });
    try {
      stubBackend(async (u) => {
        if (u.endsWith(`/interviews/${interviewId}`)) {
          // Delay the payload so the camera stream is always resolved first.
          await new Promise((resolve) => setTimeout(resolve, 80));
          return jsonResponse({ id: interviewId, status: "WAITING_FOR_ANSWER", started_at: new Date().toISOString() });
        }
        if (u.endsWith(`/interviews/${interviewId}/current`)) return jsonResponse(currentPayload());
        if (u.endsWith(`/interviews/${interviewId}/transcript`)) return jsonResponse([]);
        return jsonResponse({}, { status: 404 });
      });
      renderInterview();

      await waitFor(() => {
        const video = document.querySelector(".candidate-video-card video");
        expect(video).toBeTruthy();
        expect(video.srcObject).toBe(stream);
      });
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: original });
    }
  });

  it("routes terminal COMPLETED interviews onward", async () => {
    stubBackend((u) => {
      if (u.endsWith(`/interviews/${interviewId}`)) return jsonResponse({ id: interviewId, status: "COMPLETED" });
      if (u.endsWith(`/interviews/${interviewId}/current`)) return jsonResponse(currentPayload({ status: "COMPLETED", answer_allowed: false }));
      if (u.endsWith(`/interviews/${interviewId}/transcript`)) return jsonResponse([]);
      return jsonResponse({}, { status: 404 });
    });
    renderInterview();
    expect(await screen.findByText(/interview .* ?complete|complete the interview/i)).toBeInTheDocument();
  });
});
