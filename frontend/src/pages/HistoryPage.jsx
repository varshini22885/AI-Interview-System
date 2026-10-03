import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { getHistory } from "../api/history.js";
import { EmptyState, ErrorBox, StatusLine } from "../components/StateViews.jsx";
import { DIFFICULTY_LABELS, INTERVIEW_TYPE_LABELS } from "../lib/format.js";

const PAGE_SIZE = 10;

const STATUS_LABELS = {
  COMPLETED: "Completed",
  REPORT_READY: "Completed",
  REPORT_GENERATING: "In Progress",
  IN_PROGRESS: "In Progress",
  WAITING_FOR_ANSWER: "In Progress",
  FOLLOW_UP_REQUIRED: "In Progress",
  EVALUATING: "In Progress",
  READY: "Preparing",
  CREATED: "Preparing",
  PREPARING: "Preparing",
  FAILED: "Failed",
};

function formatHistoryDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusFor(item) {
  const label = STATUS_LABELS[item.status] || item.status || "Preparing";
  return { label, tone: label.toLowerCase().replace(" ", "-") };
}

export default function HistoryPage({ pageSizeForTest = null }) {
  const navigate = useNavigate();
  // The workspace search field navigates here with ?q=<role fragment>; the
  // filter itself still runs through the same GET /history role parameter.
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState(() => searchParams.get("q") || "");
  const [interviewType, setInterviewType] = useState("");
  const [difficulty, setDifficulty] = useState("");

  // pageSizeForTest is a test-only seam (default production PAGE_SIZE).
  const pageSize = pageSizeForTest ?? PAGE_SIZE;
  const historyQuery = useQuery({
    queryKey: ["history", page, role, interviewType, difficulty, pageSize],
    queryFn: () => getHistory({ page, pageSize, role: role || undefined, interviewType: interviewType || undefined, difficulty: difficulty || undefined }),
    placeholderData: keepPreviousData,
  });

  const items = historyQuery.data?.items ?? [];
  const total = historyQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="app-page history-page">
      <TopBar title="Interview History" />

      <main className="history-container">
        <div className="history-heading">
          <div><h1 className="visually-hidden">Interview History</h1><span className="dashboard-eyebrow">YOUR PROGRESS</span><h2>Interview History</h2><p>View your past interviews and results.</p></div>
          <div className="history-header-search"><span>⌕</span><input aria-label="Search history by role" type="search" placeholder="Search interviews..." value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} /></div>
        </div>

        <div className="history-filters-panel">
          <span className="history-filter-label">Filter by</span>
          <label htmlFor="filter-type">Interview Type</label>
          <select
            id="filter-type"
            value={interviewType}
            onChange={(e) => {
              setInterviewType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {Object.entries(INTERVIEW_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="filter-difficulty">Difficulty</label>
          <select
            id="filter-difficulty"
            value={difficulty}
            onChange={(e) => {
              setDifficulty(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {Object.entries(DIFFICULTY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="history-clear-filters" type="button" disabled={!role && !interviewType && !difficulty} onClick={() => { setRole(""); setInterviewType(""); setDifficulty(""); setPage(1); }}>Clear filters</button>
        </div>

        {historyQuery.isPending ? <StatusLine>Loading history…</StatusLine> : null}
        <ErrorBox error={historyQuery.error} onRetry={() => historyQuery.refetch()} />

        {!historyQuery.isPending && !historyQuery.error && items.length === 0 ? (
          <EmptyState title="No interviews yet">
            <span className="visually-hidden">No interviews found</span>
            <p>Start your first interview to see your progress here.</p>
            <button className="main-button" type="button" onClick={() => navigate("/setup")}>
              Start Interview →
            </button>
          </EmptyState>
        ) : null}

        {items.length > 0 ? <section className="history-table-card" aria-label="Interview history">
          <div className="history-table-row history-table-head" role="row"><span>Date &amp; Time</span><span>Role</span><span>Type</span><span>Status</span><span>Report</span><span>Actions</span></div>
          {items.map((item) => {
            const status = statusFor(item);
            const reportReady = ["COMPLETED", "REPORT_READY"].includes(item.status);
            const active = ["IN_PROGRESS", "WAITING_FOR_ANSWER", "FOLLOW_UP_REQUIRED", "EVALUATING"].includes(item.status);
            const actionPath = reportReady ? `/report/${item.id}` : active ? `/interview/${item.id}` : `/lobby/${item.id}`;
            const actionLabel = reportReady ? "View" : active ? "Continue" : "Open";
            return <div className="history-table-row" role="row" key={item.id}><span className="history-date-value">{formatHistoryDateTime(item.completed_at)}</span><strong>{item.target_role}</strong><span>{INTERVIEW_TYPE_LABELS[item.interview_type] || item.interview_type}</span><span><em className={`history-status history-status-${status.tone}`}>{status.label}</em></span><button className="history-report-button" type="button" onClick={() => navigate(actionPath)}>{actionLabel} →</button><button className="history-action-button" type="button" onClick={() => navigate(actionPath)} aria-label={`${actionLabel} ${item.target_role}`}>↗</button></div>;
          })}
        </section> : null}

        {totalPages > 1 ? (
          <div className="history-pagination" role="navigation" aria-label="History pages">
            <span>Showing page <strong>{page}</strong> of <strong>{totalPages}</strong></span>
            <div><button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</button><button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button></div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
