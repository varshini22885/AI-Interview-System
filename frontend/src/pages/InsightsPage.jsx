import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { getHistory } from "../api/history.js";
import { getReport } from "../api/reports.js";
import { EmptyState, ErrorBox, StatusLine } from "../components/StateViews.jsx";
import { DIFFICULTY_LABELS, INTERVIEW_TYPE_LABELS, scoreBandLabel } from "../lib/format.js";

/**
 * Insights = derived analytics over persisted interviews (GET /history) plus
 * persisted reports (GET /reports/{id}). History stays a record list; nothing
 * here invents numbers the backend does not return.
 */
const MAX_SESSIONS = 100;
const MAX_REPORTS = 3;
const TREND_POINTS = 8;
const COMPLETED_STATUSES = ["COMPLETED", "REPORT_READY"];
const ACTIVE_STATUSES = ["IN_PROGRESS", "WAITING_FOR_ANSWER", "FOLLOW_UP_REQUIRED", "EVALUATING"];

function isScore(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function averageOf(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function formatShortDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function FeedbackLines({ text, emptyMessage }) {
  if (!text) return <p className="insights-empty-copy">{emptyMessage}</p>;
  const lines = String(text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return <p>{text}</p>;
  return <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>;
}

function MetricBar({ label, value, suffix }) {
  const available = isScore(value);
  return (
    <div className={`insights-metric ${available ? "" : "unavailable"}`}>
      <div><span>{label}</span><strong>{available ? `${value}%` : "Not provided"}</strong></div>
      <div className="insights-metric-track"><span style={available ? { width: `${Math.max(0, Math.min(100, value))}%` } : undefined} /></div>
      {suffix ? <small>{suffix}</small> : null}
    </div>
  );
}
export default function InsightsPage() {
  const navigate = useNavigate();

  const historyQuery = useQuery({
    queryKey: ["insights-history"],
    queryFn: () => getHistory({ page: 1, pageSize: MAX_SESSIONS }),
  });

  const items = useMemo(() => historyQuery.data?.items ?? [], [historyQuery.data]);

  const scoredItems = useMemo(() => items.filter((item) => isScore(item.overall_score)), [items]);
  const trend = useMemo(() => [...scoredItems].reverse().slice(-TREND_POINTS), [scoredItems]);
  const reportTargets = useMemo(() => scoredItems.filter((item) => item.status === "REPORT_READY").slice(0, MAX_REPORTS), [scoredItems]);

  const reportQueries = useQueries({
    queries: reportTargets.map((interview) => ({
      queryKey: ["report", interview.id],
      queryFn: () => getReport(interview.id),
      retry: false,
      staleTime: 60_000,
    })),
  });

  const loadedReports = reportQueries.map((query) => query.data).filter(Boolean);
  const latestReportIndex = reportQueries.findIndex((query) => Boolean(query.data));
  const latestReport = latestReportIndex >= 0 ? reportQueries[latestReportIndex].data : null;
  const latestReportInterview = latestReportIndex >= 0 ? reportTargets[latestReportIndex] : null;

  const total = historyQuery.data?.total ?? items.length;
  const averageScore = averageOf(scoredItems.map((item) => Number(item.overall_score)));
  const bestScore = scoredItems.length ? Math.max(...scoredItems.map((item) => Number(item.overall_score))) : null;
  const completedCount = items.filter((item) => COMPLETED_STATUSES.includes(item.status)).length;
  const failedCount = items.filter((item) => item.status === "FAILED").length;
  const activeCount = items.filter((item) => ACTIVE_STATUSES.includes(item.status)).length;
  const completionRate = items.length ? Math.round((completedCount / items.length) * 100) : null;
  const questionsPractised = items.reduce((sum, item) => sum + (Number(item.total_questions) || 0), 0);
  const technicalAverage = averageOf(loadedReports.map((report) => report.technical_score).filter(isScore));
  const communicationAverage = averageOf(loadedReports.map((report) => report.communication_score).filter(isScore));

  const typeMix = Object.keys(INTERVIEW_TYPE_LABELS)
    .map((type) => ({ label: INTERVIEW_TYPE_LABELS[type], count: items.filter((item) => item.interview_type === type).length }))
    .filter((entry) => entry.count > 0);
  const difficultyMix = Object.keys(DIFFICULTY_LABELS)
    .map((level) => ({ label: DIFFICULTY_LABELS[level], count: items.filter((item) => item.difficulty === level).length }))
    .filter((entry) => entry.count > 0);

  const hasSessions = !historyQuery.isPending && !historyQuery.error && items.length > 0;

  return (
    <div className="app-page insights-page">
      <TopBar title="Insights" />

      <main className="insights-container">
        <div className="insights-heading">
          <div>
            <h1 className="visually-hidden">Insights</h1>
            <span className="dashboard-eyebrow">ANALYTICS &amp; PROGRESS</span>
            <h2>Insights</h2>
            <p>How your preparation is trending, based on your recorded interviews and reports.</p>
          </div>
          <button className="insights-heading-action" type="button" onClick={() => navigate("/history")}>View history →</button>
        </div>

        {historyQuery.isPending ? <StatusLine>Loading insights…</StatusLine> : null}
        <ErrorBox error={historyQuery.error} onRetry={() => historyQuery.refetch()} />

        {!historyQuery.isPending && !historyQuery.error && items.length === 0 ? (
          <EmptyState title="No insights yet">
            <p>Insights appear after your first interview. Start a session to build your progress record.</p>
            <button className="main-button" type="button" onClick={() => navigate("/setup")}>Start Interview →</button>
          </EmptyState>
        ) : null}

        {hasSessions ? (
          <>
            <section className="insights-kpis" aria-label="Key metrics">
              <div className="summary-card summary-purple">
                <span className="summary-icon" aria-hidden="true">◷</span>
                <span className="summary-label">Interviews Recorded</span>
                <strong>{total}</strong>
                <small>{activeCount} in progress · {failedCount} failed</small>
              </div>
              <div className="summary-card summary-blue">
                <span className="summary-icon" aria-hidden="true">✓</span>
                <span className="summary-label">Completed</span>
                <strong>{completedCount}</strong>
                <small>{completionRate === null ? "Completion rate pending" : `${completionRate}% completion rate`}</small>
              </div>
              <div className="summary-card summary-green">
                <span className="summary-icon" aria-hidden="true">↗</span>
                <span className="summary-label">Average Score</span>
                <strong>{averageScore === null ? "—" : `${averageScore}%`}</strong>
                <small>{averageScore === null ? "No scored interview yet" : scoreBandLabel(averageScore)}</small>
              </div>
              <div className="summary-card summary-highlight">
                <span className="summary-icon" aria-hidden="true">✦</span>
                <span className="summary-label">Best Score</span>
                <strong>{bestScore === null ? "—" : `${bestScore}%`}</strong>
                <small>{bestScore === null ? "Complete an interview to score" : "Highest overall score"}</small>
              </div>
            </section>


            <div className="insights-grid">
              <section className="insights-panel insights-trend" aria-label="Score trend">
                <div className="panel-heading">
                  <div><span className="dashboard-eyebrow">SCORE TREND</span><h2>Performance Over Time</h2></div>
                  <span className="insights-note">{trend.length} scored interview{trend.length === 1 ? "" : "s"}</span>
                </div>
                {trend.length === 0 ? (
                  <p className="insights-empty-copy">No scored interview yet. Your trend appears as soon as a report is ready.</p>
                ) : (
                  <div
                    className="insights-chart"
                    role="img"
                    aria-label={`Overall score for the last ${trend.length} scored interviews: ${trend.map((item) => `${item.overall_score} percent on ${formatShortDate(item.completed_at)}`).join(", ")}`}
                  >
                    {trend.map((item) => (
                      <div className="insights-bar" key={item.id}>
                        <span className="insights-bar-value">{item.overall_score}%</span>
                        <span className="insights-bar-track"><span style={{ height: `${Math.max(4, Math.min(100, Number(item.overall_score)))}%` }} /></span>
                        <span className="insights-bar-label">{formatShortDate(item.completed_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="insights-panel" aria-label="Skills breakdown">
                <div className="panel-heading">
                  <div><span className="dashboard-eyebrow">SKILLS BREAKDOWN</span><h2>Technical vs Communication</h2></div>
                  <span className="insights-note">{loadedReports.length} report{loadedReports.length === 1 ? "" : "s"}</span>
                </div>
                {reportTargets.length === 0 ? (
                  <p className="insights-empty-copy">Skill averages need a ready report. Complete an interview to generate one.</p>
                ) : loadedReports.length === 0 ? (
                  <StatusLine>Loading report data…</StatusLine>
                ) : (
                  <div className="insights-metrics">
                    <MetricBar label="Technical Knowledge" value={technicalAverage} suffix="Average of the sampled reports" />
                    <MetricBar label="Communication" value={communicationAverage} suffix="Average of the sampled reports" />
                  </div>
                )}
              </section>


              <section className="insights-panel" aria-label="Preparation metrics">
                <div className="panel-heading">
                  <div><span className="dashboard-eyebrow">PREPARATION METRICS</span><h2>Practice Volume</h2></div>
                </div>
                <div className="insights-stats">
                  <div><span>QUESTIONS PRACTISED</span><strong>{questionsPractised}</strong></div>
                  <div><span>SESSIONS TRACKED</span><strong>{items.length}</strong></div>
                  <div><span>COMPLETED</span><strong>{completedCount}</strong></div>
                  <div><span>IN PROGRESS</span><strong>{activeCount}</strong></div>
                </div>
                {typeMix.length > 0 || difficultyMix.length > 0 ? (
                  <div className="insights-mix">
                    {typeMix.length > 0 ? (
                      <div>
                        <span className="insights-mix-label">BY INTERVIEW TYPE</span>
                        <span className="insights-mix-chips">{typeMix.map((entry) => <em key={entry.label}>{entry.label}<b>{entry.count}</b></em>)}</span>
                      </div>
                    ) : null}
                    {difficultyMix.length > 0 ? (
                      <div>
                        <span className="insights-mix-label">BY DIFFICULTY</span>
                        <span className="insights-mix-chips">{difficultyMix.map((entry) => <em key={entry.label}>{entry.label}<b>{entry.count}</b></em>)}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="insights-panel" aria-label="Latest feedback highlights">
                <div className="panel-heading">
                  <div><span className="dashboard-eyebrow">LATEST FEEDBACK</span><h2>Strengths &amp; Focus Areas</h2></div>
                  {latestReportInterview ? <Link className="insights-inline-link" to={`/report/${latestReportInterview.id}`}>Open report →</Link> : null}
                </div>
                {!latestReport ? (
                  <p className="insights-empty-copy">Feedback highlights appear once the interview service has persisted a report.</p>
                ) : (
                  <div className="insights-feedback">
                    <div>
                      <h3>Strengths</h3>
                      <FeedbackLines text={latestReport.strengths} emptyMessage="No strengths were recorded in this report." />
                    </div>
                    <div>
                      <h3>Areas for Improvement</h3>
                      <FeedbackLines text={latestReport.areas_for_improvement} emptyMessage="No improvement notes were recorded in this report." />
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

