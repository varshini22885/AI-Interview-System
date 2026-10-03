import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { TopBar } from "../App.jsx";
import {
  finishInterview,
  getCurrentQuestion,
  getInterview,
  getTranscript,
  pauseInterview,
  submitAnswer,
} from "../api/interviews.js";
import { ErrorBox, StatusLine } from "../components/StateViews.jsx";
import useRealtimeSession, { realtimeSummary } from "../hooks/useRealtimeSession.js";
import { formatElapsed, newIdempotencyKey, pad2 } from "../lib/format.js";

const ACTIVE_POLL_INTERVAL_MS = 2000;
// Statuses for which the backend accepts a realtime session (others are refused).
const REALTIME_ACTIVE_STATUSES = ["IN_PROGRESS", "WAITING_FOR_ANSWER", "FOLLOW_UP_REQUIRED", "EVALUATING"];
// A reload can briefly refuse the camera while the previous capture closes, so
// re-acquisition is retried for several seconds before the UI calls it failed.
const CAMERA_MAX_ATTEMPTS = 6;
const CAMERA_RETRY_DELAY_MS = 300;

/** Idempotency key ref: one key per LOGICAL submission. Retrying the same
 * answer (network failure, double click) reuses the SAME key; starting a
 * new answer generates a new one. Keys are never logged. */
function useIdempotencyKey() {
  const keyRef = useRef(null);
  const reset = useCallback(() => {
    keyRef.current = null;
  }, []);
  const next = useCallback(() => {
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    return keyRef.current;
  }, []);
  return { next, reset };
}

/** Presentation-only elapsed time derived from the server's started_at. */
function useElapsedTicker(startedAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return formatElapsed(startedAt, now);
}

export default function InterviewPage() {
  const { interviewId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

    const [draft, setDraft] = useState("");
  const idempotency = useIdempotencyKey();
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [activeTab, setActiveTab] = useState("transcript");
  const [cameraState, setCameraState] = useState("connecting");
  const [cameraError, setCameraError] = useState(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const videoRef = useRef(null);
  const [mediaStream, setMediaStream] = useState(null);
  const [videoElement, setVideoElement] = useState(null);
  const mediaStreamRef = useRef(null);

  const interviewQuery = useQuery({ queryKey: ["interview", interviewId], queryFn: () => getInterview(interviewId) });
  const transcriptQuery = useQuery({
    queryKey: ["transcript", interviewId],
    queryFn: () => getTranscript(interviewId),
  });

  const currentQuery = useQuery({
    queryKey: ["current", interviewId],
    queryFn: () => getCurrentQuestion(interviewId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const active = status === "EVALUATING" || status === "NEXT_QUESTION";
      return active && query.state.dataUpdateCount < 150 ? ACTIVE_POLL_INTERVAL_MS : false;
    },
  });

  const current = currentQuery.data;
  const status = current?.status ?? interviewQuery.data?.status;
  const answerAllowed = Boolean(current?.answer_allowed);
  // During FOLLOW_UP_REQUIRED the authoritative follow-up text is the question;
  // its parent question id (current.question_id) is what submit_answer expects.
  const followUp = current?.follow_up ?? null;
  const elapsed = useElapsedTicker(interviewQuery.data?.started_at);

  useEffect(() => {
    let cancelled = false;
    async function connectCamera(attempt = 1) {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("unavailable");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStreamRef.current = stream;
        setMediaStream(stream);
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCameraState("ready");
      } catch (err) {
        setCameraError(err?.name || "MediaError");
        // A hard reload tears the previous document's capture down asynchronously,
        // so the browser can answer the first getUserMedia with NotReadableError
        // while the old devices are still closing. Retry briefly before giving up
        // so a refresh (and the E2E media-permission-after-reload check) recovers.
        if (attempt < CAMERA_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, CAMERA_RETRY_DELAY_MS * 2 ** (attempt - 1)));
          if (!cancelled) await connectCamera(attempt + 1);
          return;
        }
        setCameraError((current) => current || "UnknownError");
        setCameraState("unavailable");
      }
    }
    connectCamera();
    // Release the devices as soon as the document goes away (reload, navigation,
    // tab close). The next document can only open the camera once the previous
    // capture is fully torn down, so an explicit stop keeps F5 instant instead of
    // racing the browser's own teardown.
    const releaseCapture = () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    };
    window.addEventListener("pagehide", releaseCapture);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", releaseCapture);
      releaseCapture();
      setMediaStream(null);
    };
  }, []);

  // The interview markup (and therefore the <video> element) only mounts once
  // the interview query resolves, while the stream above is acquired on mount.
  // On a cold load (hard refresh or deep link into /interview/:id) the stream is
  // ready before the element exists, so binding must be re-checked on every
  // render; otherwise the camera stays live but the preview stays blank.
  useEffect(() => {
    const stream = mediaStreamRef.current;
    const element = videoRef.current;
    if (element && element !== videoElement) setVideoElement(element);
    if (stream && element && element.srcObject !== stream) {
      element.srcObject = stream;
    }
  });

  /**
   * Realtime server events never write state directly: the REST interview
   * status stays authoritative, so cached reads are only invalidated.
   */
  const handleRealtimeEvent = useCallback((message) => {
    if (!message?.type) return;
    if (message.type === "question_started") {
      queryClient.invalidateQueries({ queryKey: ["current", interviewId] });
      return;
    }
    if (message.type === "transcript_final" || message.type === "evaluation_started") {
      queryClient.invalidateQueries({ queryKey: ["transcript", interviewId] });
      queryClient.invalidateQueries({ queryKey: ["current", interviewId] });
      queryClient.invalidateQueries({ queryKey: ["interview", interviewId] });
    }
  }, [queryClient, interviewId]);

  // Authenticated realtime WebSocket: session creation, mic frames, question
  // audio replay, and face telemetry. Enabled only for interview states the
  // backend accepts (it refuses sessions for non-active interviews).
  const realtime = useRealtimeSession({
    interviewId,
    enabled: REALTIME_ACTIVE_STATUSES.includes(status),
    mediaStream,
    videoElement,
    onServerEvent: handleRealtimeEvent,
  });

  const submitMutation = useMutation({
    mutationFn: ({ questionId, text, key }) =>
      submitAnswer(interviewId, { questionId, answerText: text, idempotencyKey: key }),
        onSuccess: () => {
      idempotency.reset();
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["current", interviewId] });
      queryClient.invalidateQueries({ queryKey: ["transcript", interviewId] });
      queryClient.invalidateQueries({ queryKey: ["interview", interviewId] });
    },
  });

  const finishMutation = useMutation({
    mutationFn: () => finishInterview(interviewId),
    onSuccess: (interview) => {
      queryClient.invalidateQueries({ queryKey: ["interview", interviewId] });
      if (interview?.status === "COMPLETED") navigate(`/report/${interviewId}`);
    },
  });

  async function onPause() {
    setActionError(null);
    setNotice(null);
    try {
      await pauseInterview(interviewId);
    } catch (err) {
      // The backend has no PAUSED state by design; surface its message.
      setNotice(err.message || "Pause is not currently available for this interview.");
    }
  }

  function onSubmitAnswer(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !current?.question_id || submitMutation.isPending) return;
    setActionError(null);
    const key = idempotency.next();
    submitMutation.mutate({ questionId: current.question_id, text, key });
  }

  function toggleCamera() {
    const next = !cameraEnabled;
    mediaStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; });
    setCameraEnabled(next);
  }

  function toggleMic() {
    const next = !micEnabled;
    mediaStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    setMicEnabled(next);
  }

  function endInterview() {
    if (window.confirm("Finish the interview now and get your report?")) finishMutation.mutate();
  }

  function liveStateLabel() {
    if (finished) return "Completed";
    if (status === "FAILED") return "Failed";
    if (status === "EVALUATING") return "Evaluating";
    if (status === "NEXT_QUESTION") return "Next question";
    if (status === "FOLLOW_UP_REQUIRED") return "Follow-up";
    if (status === "WAITING_FOR_ANSWER") return "Listening";
    if (status === "IN_PROGRESS") return "User speaking";
    return status || "Connecting";
  }

  if (interviewQuery.isPending || interviewQuery.error) {
    return (
      <div className="app-page">
        <TopBar title="Interview" />
        <div className="page-container">
          <StatusLine>{interviewQuery.isPending ? "Loading interview…" : ""}</StatusLine>
          <ErrorBox error={interviewQuery.error} onRetry={() => interviewQuery.refetch()} />
        </div>
      </div>
    );
  }

  const finished = ["COMPLETED", "REPORT_GENERATING", "REPORT_READY"].includes(status);
  if (status === "FAILED") {
    return (
      <div className="app-page">
        <TopBar title="Interview" />
        <div className="page-container">
          <h1>This interview failed.</h1>
          <p>Please create a new interview from the setup page.</p>
          <button className="main-button" type="button" onClick={() => navigate("/setup")}>
            Back to Setup
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="interview-page live-interview-page">
      <TopBar title="AI Interview" />
      <main className="live-interview-main">
        <div className="live-interview-head">
          <div><span className="live-brand-dot">✦</span><span><strong>AI Interviewer</strong><small>{liveStateLabel()}</small></span></div>
          <div className="live-question-progress">QUESTION {pad2((current?.order_index ?? 0) + 1)} / {pad2(current?.total_questions ?? interviewQuery.data?.total_questions ?? 0)}</div>
          <div className="live-head-actions"><span className="live-realtime-status" role="status" title={[realtime.reason, realtime.stt?.reason, realtime.tts?.reason, realtime.face?.reason].filter(Boolean).join(" | ") || undefined}>{realtimeSummary(realtime)}</span><span className="live-timer" aria-label="Elapsed time, derived from the server start time">{elapsed ?? "--:--"}</span><button className="end-interview-button" type="button" disabled={finishMutation.isPending} onClick={endInterview}>{finishMutation.isPending ? "Ending…" : "End Interview"}</button></div>
        </div>

        <div className="live-video-grid">
          <section className="video-card candidate-video-card">
            <div className="video-card-top"><span className={`video-status-dot ${cameraState === "ready" && cameraEnabled ? "online" : "offline"}`} />{cameraState === "ready" && cameraEnabled ? "Camera On" : cameraState === "connecting" ? "Connecting camera…" : cameraError ? `Camera unavailable (${cameraError})` : "Camera unavailable"}</div>
            <video ref={videoRef} autoPlay muted playsInline aria-label="Your camera preview" />
            {cameraState !== "ready" || !cameraEnabled ? <div className="video-placeholder"><span className="candidate-avatar">YOU</span><small>{cameraState === "connecting" ? "Connecting to camera" : "Camera is off"}</small></div> : null}
            <div className="candidate-name">You <span>{micEnabled ? "Microphone active" : "Muted"}</span></div>
            <div className="video-controls"><button type="button" aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"} onClick={toggleCamera}>{cameraEnabled ? "▣" : "□"}</button><button type="button" aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"} onClick={toggleMic}>{micEnabled ? "◉" : "⊘"}</button><button type="button" onClick={onPause}>⋯</button><button className="video-end-button" type="button" onClick={endInterview}>⌁</button></div>
          </section>
          <section className="video-card ai-video-card"><div className="video-card-top"><span className="video-status-dot online" />AI Interviewer</div><div className="ai-video-visual"><span className="ai-orbit" /><span className="ai-face">A</span><span className="ai-wave ai-wave-one" /><span className="ai-wave ai-wave-two" /></div><div className="ai-video-status"><strong>{status === "EVALUATING" ? "Processing Answer" : status === "FOLLOW_UP_REQUIRED" ? "Follow-up ready" : status === "NEXT_QUESTION" ? "Preparing next question" : finished ? "Completed" : "Listening..."}</strong><small>AI interviewer</small></div></section>
        </div>

        <div className="live-content-grid">
          <section className="live-question-column">
            <div className="current-question-card"><div className="question-card-label"><span>✦</span> CURRENT QUESTION <em>{liveStateLabel()}</em></div><h1>{current?.question_text || "Waiting for the next question…"}</h1><div className="question-audio-state"><span className={`audio-pulse ${status === "WAITING_FOR_ANSWER" ? "active" : ""}`}><i /><i /><i /><i /><i /></span><strong>{status === "EVALUATING" ? "Evaluating your answer..." : status === "NEXT_QUESTION" ? "Preparing the next question..." : status === "FOLLOW_UP_REQUIRED" ? "Follow-up question" : "Listening..."}</strong></div></div>
            {answerAllowed && current && !finished ? <form className="answer-area live-answer-area" onSubmit={onSubmitAnswer}><label htmlFor="answer-text" className="sr-only">Your answer</label><textarea id="answer-text" placeholder={status === "FOLLOW_UP_REQUIRED" ? "Continue your answer..." : "Type your answer here..."} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={submitMutation.isPending} /><div className="answer-actions"><span>{status === "FOLLOW_UP_REQUIRED" ? "Follow-up question from your AI interviewer" : "AI is listening..."}</span><button className="main-button" type="submit" disabled={submitMutation.isPending || !draft.trim()}>{submitMutation.isPending ? "Submitting…" : "Send Answer →"}</button></div></form> : null}
          </section>
          <section className="live-transcript-panel"><div className="transcript-tabs"><button className={activeTab === "transcript" ? "active" : ""} type="button" onClick={() => setActiveTab("transcript")}>Transcript</button><button className={activeTab === "evaluation" ? "active" : ""} type="button" onClick={() => setActiveTab("evaluation")}>Evaluation</button></div>{activeTab === "transcript" ? <div className="transcript-scroll">{transcriptQuery.isPending && !current ? <StatusLine>Loading conversation…</StatusLine> : null}<ErrorBox error={transcriptQuery.error} onRetry={() => transcriptQuery.refetch()} />{(transcriptQuery.data ?? []).filter((item) => String(item.question_id) !== String(current?.question_id)).map((item) => <div key={item.question_id}><ChatRow role="ai" label="AI Interviewer">{item.question_text}</ChatRow>{item.answers.map((answer) => <ChatRow key={answer.answer_id} role="user" label={`You · attempt ${answer.attempt_number}`}>{answer.answer_text}</ChatRow>)}{item.follow_ups.map((itemFollowUp) => <ChatRow key={`${item.question_id}-${itemFollowUp.created_at}`} role="ai" label="AI Interviewer">{itemFollowUp.follow_up_text}</ChatRow>)}</div>)}<ErrorBox error={currentQuery.error} onRetry={() => currentQuery.refetch()} /><ErrorBox error={submitMutation.error} /><ErrorBox error={actionError} />{notice ? <p className="status-line" role="status">{notice}</p> : null}{status === "FOLLOW_UP_REQUIRED" && followUp ? <ChatRow role="ai" label="AI Interviewer">{followUp.follow_up_text}</ChatRow> : null}{finished ? <StatusLine>Interview complete. Your final report is being generated.</StatusLine> : null}</div> : <div className="evaluation-empty"><span>◌</span><strong>Evaluation appears after an answer is processed.</strong><p>Only evaluation information returned by the interview service will appear here.</p></div>}</section>
        </div>
      </main>
    </div>
  );
}

function ChatRow({ role, label, children }) {
  if (role === "user") {
    return (
      <div className="chat-row user-row">
        <div className="chat-message user-message">
          <span className="message-label">{label}</span>
          <p>{children}</p>
        </div>
        <div className="chat-avatar user-avatar">YOU</div>
      </div>
    );
  }
  return (
    <div className="chat-row ai-row">
      <div className="chat-avatar">AI</div>
      <div className="chat-message ai-message">
        <span className="message-label">{label}</span>
        <p className="main-question">{children}</p>
      </div>
    </div>
  );
}
