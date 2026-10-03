import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { TopBar } from "../App.jsx";
import { useAuth } from "../auth/useAuth.js";
import { getHistory } from "../api/history.js";
import { listResumes } from "../api/resumes.js";
import { formatDateTime } from "../lib/format.js";

const FEATURES = [
  { number: "01", title: "Resume & Role Analysis", text: "Upload your resume and select your target role.", to: "/resume" },
  { number: "02", title: "Dynamic Question Generation", text: "Generate personalized questions for your interview.", to: "/setup" },
  { number: "03", title: "Role-Based Prompting", text: "Get questions based on your selected job role.", to: "/setup" },
  { number: "04", title: "Conversational Interview", text: "Experience a realistic AI-powered interview.", to: "/history" },
  { number: "05", title: "Follow-up Questions", text: "AI generates intelligent follow-up questions.", to: "/history" },
  { number: "06", title: "Answer Evaluation", text: "Get AI-based evaluation of your answers.", to: "/history" },
  { number: "07", title: "Personalized Feedback", text: "Understand your strengths and areas to improve.", to: "/history" },
  { number: "08", title: "Performance Report", text: "View your complete interview performance.", to: "/history" },
  { number: "09", title: "Interview History", text: "Review your previous interview results.", to: "/history" },
];

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

function DashboardHome({ user }) {
  const navigate = useNavigate();
  // One real backend read drives both the recent list and the performance
  // snapshot; every number below is derived from persisted interview rows.
  const historyQuery = useQuery({
    queryKey: ["dashboard-history"],
    queryFn: () => getHistory({ page: 1, pageSize: 50 }),
  });
  const resumesQuery = useQuery({
    queryKey: ["dashboard-resumes"],
    queryFn: () => listResumes(1, 1),
  });

  const interviews = historyQuery.data?.items ?? [];
  const recentInterviews = interviews.slice(0, 5);
  const latestResume = resumesQuery.data?.items?.[0];
  const scoredInterviewScores = interviews.filter((item) => typeof item.overall_score === "number").map((item) => Number(item.overall_score));
  const averageScore = scoredInterviewScores.length ? Math.round(scoredInterviewScores.reduce((sum, score) => sum + score, 0) / scoredInterviewScores.length) : null;
  const bestScore = scoredInterviewScores.length ? Math.max(...scoredInterviewScores) : null;
  const avgSuffix = scoredInterviewScores.length === 1 ? "1 scored interview" : `${scoredInterviewScores.length} scored interviews`;
  const displayName = user?.full_name || user?.email || "there";

  return (
    <div className="app-page dashboard-page">
      <TopBar title="Dashboard" />
      <div className="dashboard-container">
        <section className="dashboard-welcome">
          <div className="welcome-copy">
            <span className="dashboard-eyebrow">YOUR PREPARATION SPACE</span>
            <h1>Welcome back,<br /><strong>{displayName}</strong></h1>
            <p>Your preparation journey continues.<br />Practice, improve and achieve your goals.</p>
            <div className="welcome-actions">
              <button className="main-button" type="button" onClick={() => navigate("/setup")}>Start Interview →</button>
              <button className="secondary-button" type="button" onClick={() => navigate("/resume")}>Upload Resume</button>
            </div>
          </div>
          <div className="dashboard-hero-art" aria-hidden="true">
            <span className="hero-art-orbit orbit-one" />
            <span className="hero-art-orbit orbit-two" />
            <span className="hero-art-spark spark-a">✦</span>
            <span className="hero-art-spark spark-b">✦</span>
            <span className="hero-art-screen"><i /><b /><em /></span>
            <span className="hero-art-person"><i /><b /></span>
          </div>
        </section>

        <section className="dashboard-summary" aria-label="Preparation summary">
          <div className="summary-card summary-purple"><span className="summary-icon" aria-hidden="true">▣</span><span className="summary-label">Resume Status</span><strong>{latestResume ? (latestResume.status === "PROCESSED" || latestResume.parsed_at ? "Ready" : "Processing") : "Not uploaded"}</strong><small>{latestResume?.filename || "Upload your resume to begin"}</small></div>
          <div className="summary-card summary-blue"><span className="summary-icon" aria-hidden="true">◷</span><span className="summary-label">Recent Interviews</span><strong>{historyQuery.isPending ? "—" : historyQuery.data?.total ?? 0}</strong><small>Interview sessions recorded</small></div>
          <div className="summary-card summary-green"><span className="summary-icon" aria-hidden="true">↗</span><span className="summary-label">Average Score</span><strong>{averageScore === null ? "—" : `${averageScore}%`}</strong><small>{averageScore === null ? "Complete an interview to score" : `Across ${avgSuffix}`}</small></div>
          <div className="summary-card summary-highlight"><span className="summary-icon" aria-hidden="true">✦</span><span className="summary-label">Best Score</span><strong>{bestScore === null ? "—" : `${bestScore}%`}</strong><small>{bestScore === null ? "No scored interview yet" : "Your highest interview score"}</small></div>
        </section>

        <div className="dashboard-grid">
          <section className="recent-interviews dashboard-panel">
            <div className="panel-heading"><div><span className="dashboard-eyebrow">YOUR ACTIVITY</span><h2>Recent Interviews</h2></div><button type="button" onClick={() => navigate("/history")}>View all →</button></div>
            {historyQuery.isPending ? <p className="dashboard-status">Loading interviews…</p> : null}
            {historyQuery.error ? <p className="dashboard-status dashboard-error">Unable to load recent interviews.</p> : null}
            {!historyQuery.isPending && !historyQuery.error && recentInterviews.length === 0 ? <p className="dashboard-status">No interviews yet. Start your first practice session.</p> : null}
            {recentInterviews.length > 0 ? (
              <div className="interview-table" role="table" aria-label="Recent interviews">
                <div className="interview-row interview-row-head" role="row"><span>Date</span><span>Role</span><span>Status</span><span>Report</span></div>
                {recentInterviews.map((item) => {
                  const statusLabel = STATUS_LABELS[item.status] || item.status || "Preparing";
                  const reportReady = ["COMPLETED", "REPORT_READY"].includes(item.status);
                  return <div className="interview-row" role="row" key={item.id}><span>{formatDateTime(item.completed_at)}</span><strong>{item.target_role}</strong><span><em className={`status-badge status-${statusLabel.toLowerCase().replace(" ", "-")}`}>{statusLabel}</em></span><button type="button" disabled={!reportReady} onClick={() => navigate(`/report/${item.id}`)}>{reportReady ? "View →" : "—"}</button></div>;
                })}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function Home() {
  const navigate = useNavigate();
  const { user, status, logout } = useAuth();

  if (status === "authenticated") return <DashboardHome user={user} />;

  return (
    <div className="home-page">
      {/* NAVBAR */}

      <nav className="navbar">
        <div className="brand">
          <div className="brand-logo">AI</div>
          <strong>AI INTERVIEW PREPARATION SYSTEM</strong>
        </div>

        <div className="nav-links">
          <button type="button" onClick={() => navigate("/")}>
            Home
          </button>
          <button type="button" onClick={() => navigate(status === "authenticated" ? "/history" : "/login")}>
            History
          </button>
          {status === "authenticated" ? (
            <>
              <span className="nav-user">{user?.email}</span>
              <button type="button" onClick={() => logout()}>
                Log out
              </button>
            </>
          ) : (
            <button type="button" onClick={() => navigate("/login")}>
              Sign in
            </button>
          )}
        </div>
      </nav>

      {/* HERO */}

      <section className="hero-section">
        <div className="hero-content">
          <span className="hero-badge">✦ AI-POWERED INTERVIEW PLATFORM</span>
          <h1>
            AI INTERVIEW
            <br />
            <span>PREPARATION SYSTEM</span>
          </h1>
          <p>
            Practice smarter. Prepare better.
            <br />
            Perform better with AI-powered interviews.
          </p>
          <button
            className="main-button hero-button"
            type="button"
            onClick={() => navigate(status === "authenticated" ? "/resume" : "/register")}
          >
            Start Interview →
          </button>
        </div>
      </section>

      {/* FEATURES */}

      <section className="features-section">
        <div className="section-heading">
          <span>PLATFORM FEATURES</span>
          <h2>Everything you need to prepare.</h2>
        </div>

        <div className="features-grid">
          {FEATURES.map((feature) => (
            <button className="feature-card" key={feature.number} type="button" onClick={() => navigate(feature.to)}>
              <span className="feature-number">{feature.number}</span>
              <span className="feature-arrow">↗</span>
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
              <span className="feature-open">Open →</span>
            </button>
          ))}
        </div>
      </section>

      {/* FOOTER */}

      <footer className="home-footer">
        <strong>AI INTERVIEW PREPARATION SYSTEM</strong>
        <span>AI-powered interview preparation</span>
      </footer>
    </div>
  );
}

export default Home;
