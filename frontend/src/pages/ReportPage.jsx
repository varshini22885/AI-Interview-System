import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { getReport } from "../api/reports.js";
import { ErrorBox, StatusLine } from "../components/StateViews.jsx";
import { scoreBandLabel } from "../lib/format.js";

function FeedbackLines({ text, emptyMessage }) {
  if (!text) return <p className="report-empty-copy">{emptyMessage}</p>;
  const lines = String(text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return <p>{text}</p>;
  return <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>;
}

function MetricBar({ label, value }) {
  const available = typeof value === "number";
  return <div className={`report-metric ${available ? "" : "unavailable"}`}><div><span>{label}</span><strong>{available ? `${value}%` : "Not provided"}</strong></div><div className="report-metric-track"><span style={available ? { width: `${Math.max(0, Math.min(100, value))}%` } : undefined} /></div></div>;
}

export default function ReportPage() {
  const { interviewId } = useParams();

  const reportQuery = useQuery({
    queryKey: ["report", interviewId],
    queryFn: () => getReport(interviewId),
    retry: false,
    // Poll only while no persisted report exists yet (COMPLETED ->
    // REPORT_GENERATING -> REPORT_READY); stop as soon as it arrives.
    refetchInterval: (query) => (query.state.data ? false : 2500),
  });

  const report = reportQuery.data;

  return (
    <div className="app-page report-page">
      <TopBar title="Interview Report" />

      <main className="report-container">
        <div className="report-heading"><div><span className="dashboard-eyebrow">PERFORMANCE REVIEW</span><h1>Interview Report</h1><p>Detailed analysis and feedback for your interview.</p></div><div className="report-heading-actions"><Link className="report-back-link" to="/history">← History</Link></div></div>

        {reportQuery.isPending ? <StatusLine>Loading report…</StatusLine> : null}

        {reportQuery.error ? (
          reportQuery.error.status === 409 ? (
            <StatusLine role="status" aria-live="polite">
              {reportQuery.error.message} — this page updates automatically.
            </StatusLine>
          ) : (
            <ErrorBox error={reportQuery.error} onRetry={() => reportQuery.refetch()} />
          )
        ) : null}

        {report ? <>
          <div className="report-top-grid">
            <section className="report-score-card"><div className="report-card-kicker">OVERALL PERFORMANCE</div><h2>Overall Performance</h2><div className="report-score-ring" style={{ "--score-value": report.overall_score }}><div><strong>{report.overall_score}</strong><small>/100</small></div></div><span className="report-complete-label">INTERVIEW COMPLETE</span><span className="report-performance-label">{scoreBandLabel(report.overall_score)}</span><p>Based on {report.total_questions_answered} evaluated answer{report.total_questions_answered === 1 ? "" : "s"}.</p></section>
            <section className="report-summary-card"><div className="report-card-kicker">YOUR RESULTS</div><h2>Evaluation Summary</h2><div className="report-metrics"><MetricBar label="Communication" value={report.communication_score} /><MetricBar label="Technical Knowledge" value={report.technical_score} /><MetricBar label="Problem Solving" value={report.problem_solving_score} /><MetricBar label="Confidence" value={report.confidence_score} /></div></section>
          </div>
          <div className="report-feedback-grid"><section className="report-feedback-card report-strengths"><div className="report-feedback-icon">✓</div><h2>Strengths</h2><FeedbackLines text={report.strengths} emptyMessage="No strengths were provided in this report." /></section><section className="report-feedback-card report-improvements"><div className="report-feedback-icon">↗</div><h2>Areas for Improvement</h2><FeedbackLines text={report.areas_for_improvement} emptyMessage="No improvement notes were provided in this report." /></section><section className="report-feedback-card report-recommendations"><div className="report-feedback-icon">✦</div><h2>Recommendations</h2><FeedbackLines text={report.recommendations} emptyMessage="No recommendations were provided in this report." /></section></div>
          <div className="report-actions"><Link className="main-button" to={`/feedback/${interviewId}`}>View Detailed Feedback →</Link><Link className="report-secondary-action" to="/history">Back to History</Link></div>
        </> : null}
      </main>
    </div>
  );
}
