import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { getInterview, startInterview } from "../api/interviews.js";
import { ErrorBox, StatusLine } from "../components/StateViews.jsx";
import { DIFFICULTY_LABELS, INTERVIEW_TYPE_LABELS } from "../lib/format.js";

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150; // ~5 minutes, then surface an honest timeout state

export default function LobbyPage() {
  const { interviewId } = useParams();
  const navigate = useNavigate();
  const [startError, setStartError] = useState(null);
  const [starting, setStarting] = useState(false);

  const interviewQuery = useQuery({
    queryKey: ["interview", interviewId],
    queryFn: () => getInterview(interviewId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const preparing = status === "CREATED" || status === "PREPARING";
      // Bounded polling: stop on READY/FAILED/terminal states or after the cap.
      return preparing && query.state.dataUpdateCount < MAX_POLLS ? POLL_INTERVAL_MS : false;
    },
    refetchIntervalInBackground: false,
  });

  const interview = interviewQuery.data;
  const status = interview?.status;
  const preparing = status === "CREATED" || status === "PREPARING";
  const timedOut = preparing && (interviewQuery.dataUpdateCount ?? 0) >= MAX_POLLS;

  async function onEnter() {
    setStartError(null);
    setStarting(true);
    try {
      await startInterview(interviewId);
      navigate(`/interview/${interviewId}`);
    } catch (err) {
      setStartError(err);
    } finally {
      setStarting(false);
    }
  }

  // Retry never fabricates success: it re-reads the server-authoritative
  // status. If the backend still reports FAILED, the state stays FAILED.
  function onRetryStatus() {
    setStartError(null);
    interviewQuery.refetch();
  }

  return (
    <div className="app-page dark-page">
      <TopBar title="Interview Lobby" dark />

      <div className="lobby">
        <div className="ai-avatar">AI</div>

        {interviewQuery.isPending ? <StatusLine>Loading interview…</StatusLine> : null}
        <ErrorBox error={interviewQuery.error} onRetry={() => interviewQuery.refetch()} />
        <ErrorBox error={startError} onRetry={() => setStartError(null)} />

        {status === "FAILED" ? (
          <>
            <span className="live-label live-label-failed" role="alert">
              ● PREPARATION FAILED
            </span>
            <h1>Preparation Failed</h1>
            <p>
              The interview service reported this session as failed while generating questions, so there is nothing to
              practise yet.
            </p>
            <p className="lobby-note">
              The failure happened on the server. Retrying only re-checks the session status — start over from setup for a
              fresh attempt.
            </p>
            <div className="lobby-failure-actions">
              <button className="main-button" type="button" onClick={onRetryStatus} disabled={interviewQuery.isFetching} aria-busy={interviewQuery.isFetching}>
                {interviewQuery.isFetching ? "Checking status…" : "Retry"}
              </button>
              <button className="secondary-button" type="button" onClick={() => navigate("/setup")}>
                Back to Setup
              </button>
            </div>
          </>
        ) : status === "CREATED" || status === "PREPARING" ? (
          <>
            <span className="live-label" role="status" aria-live="polite">
              ● AI INTERVIEWER IS PREPARING
            </span>
            <h1>Preparing your interview…</h1>
            <p>Questions are being generated for your target role. This page updates automatically.</p>
            {timedOut ? (
              <>
                <p className="lobby-note" role="alert">
                  Preparation is taking longer than expected. You can wait a little longer, re-check the status, or create a
                  new interview.
                </p>
                <button className="secondary-button" type="button" onClick={onRetryStatus} disabled={interviewQuery.isFetching}>
                  {interviewQuery.isFetching ? "Checking…" : "Check status"}
                </button>
              </>
            ) : null}
          </>
        ) : status === "READY" ? (
          <>
            <span className="live-label">● AI INTERVIEWER READY</span>
            <h1>Ready for your interview?</h1>
            <p>Your personalized interview is ready to begin.</p>
          </>
        ) : status === "REPORT_READY" || status === "COMPLETED" || status === "REPORT_GENERATING" ? (
          <>
            <span className="live-label">● INTERVIEW FINISHED</span>
            <h1>This interview is already complete.</h1>
            <button className="main-button" type="button" onClick={() => navigate(`/report/${interviewId}`)}>
              View Report →
            </button>
          </>
        ) : status ? (
          <>
            <span className="live-label">● INTERVIEW IN PROGRESS</span>
            <h1>Welcome back.</h1>
            <p>Your interview is still active. Continue where you left off.</p>
            <button className="main-button" type="button" onClick={() => navigate(`/interview/${interviewId}`)}>
              Resume Interview →
            </button>
          </>
        ) : null}

        {interview ? (
          <div className="lobby-details">
            <div>
              <small>ROLE</small>
              <strong>{interview.target_role}</strong>
            </div>
            <div>
              <small>TYPE</small>
              <strong>{INTERVIEW_TYPE_LABELS[interview.interview_type] || interview.interview_type}</strong>
            </div>
            <div>
              <small>DIFFICULTY</small>
              <strong>{DIFFICULTY_LABELS[interview.difficulty] || interview.difficulty}</strong>
            </div>
            <div>
              <small>QUESTIONS</small>
              <strong>{interview.total_questions}</strong>
            </div>
          </div>
        ) : null}

        {status === "READY" ? (
          <button className="main-button" type="button" onClick={onEnter} disabled={starting}>
            {starting ? "Entering…" : "Enter Interview →"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
