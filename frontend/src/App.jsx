import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import "./App.css";
import Home from "./pages/Home.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import ResumePage from "./pages/ResumePage.jsx";
import SetupPage from "./pages/SetupPage.jsx";
import LobbyPage from "./pages/LobbyPage.jsx";
import InterviewPage from "./pages/InterviewPage.jsx";
import EvaluationPage from "./pages/EvaluationPage.jsx";
import FeedbackPage from "./pages/FeedbackPage.jsx";
import ReportPage from "./pages/ReportPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import InsightsPage from "./pages/InsightsPage.jsx";
import HelpPage from "./pages/HelpPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import ProtectedRoute from "./auth/ProtectedRoute.jsx";
import { useAuth } from "./auth/useAuth.js";

function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        <Route
          path="/resume"
          element={
            <ProtectedRoute>
              <ResumePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/setup"
          element={
            <ProtectedRoute>
              <SetupPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/lobby/:interviewId"
          element={
            <ProtectedRoute>
              <LobbyPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/interview/:interviewId"
          element={
            <ProtectedRoute>
              <InterviewPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/evaluation/:interviewId"
          element={
            <ProtectedRoute>
              <EvaluationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/feedback/:interviewId"
          element={
            <ProtectedRoute>
              <FeedbackPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/report/:interviewId"
          element={
            <ProtectedRoute>
              <ReportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/history"
          element={
            <ProtectedRoute>
              <HistoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/insights"
          element={
            <ProtectedRoute>
              <InsightsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/help"
          element={
            <ProtectedRoute>
              <HelpPage />
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </div>
  );
}

export default App;

/* ================= TOP BAR ================= */

const SIDEBAR_STORAGE_KEY = "aiip.sidebar-collapsed";
const COMPACT_NAV_QUERY = "(max-width: 760px)";

const LOWER_NAV_ITEMS = [
  { label: "Help", icon: "?", route: "/help" },
];

/** Remember the desktop rail state so the layout does not jump between pages. */
function readSidebarPreference() {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Breakpoint tracking used only for navigation affordances (rail vs drawer). */
function useMediaQuery(query) {
  const subscribe = useCallback((onChange) => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return () => {};
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, [query]);
  const getSnapshot = useCallback(() => Boolean(globalThis.matchMedia?.(query)?.matches), [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function TopBar({ title, dark = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, status, logout } = useAuth();
  const [railCollapsed, setRailCollapsed] = useState(readSidebarPreference);
  // The drawer is remembered together with the route it was opened on, so a
  // navigation closes it without any effect-driven state reset.
  const [drawer, setDrawer] = useState({ path: null, open: false });
  const [searchTerm, setSearchTerm] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef(null);
  const isCompact = useMediaQuery(COMPACT_NAV_QUERY);
  const drawerOpen = drawer.open && drawer.path === location.pathname;

  const workspace = status === "authenticated" && !["/login", "/register"].includes(location.pathname);
  const navItems = [
    ["Dashboard", "/", "⌂"],
    ["Interview Setup", "/setup", "✦"],
    ["Resume", "/resume", "▣"],
    ["Insights", "/insights", "◌"],
    ["History", "/history", "◷"],
  ];
  const isNavActive = (path) => path === "/" ? location.pathname === "/" : location.pathname === path || location.pathname.startsWith(`${path}/`);

  // Desktop rail state is published as a root data attribute so every
  // workspace page offset (which lives in each page's own wrapper class)
  // stays in sync without prop drilling.
  useEffect(() => {
    if (!workspace) return undefined;
    document.documentElement.dataset.sidebar = railCollapsed ? "collapsed" : "expanded";
    try {
      globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, String(railCollapsed));
    } catch {
      // Storage can be unavailable (private mode); the toggle still works.
    }
    return () => {
      delete document.documentElement.dataset.sidebar;
    };
  }, [railCollapsed, workspace]);

                                    // A route change always leaves the mobile drawer and account menu closed.
            const closeDrawer = () => {
              setDrawer({ path: location.pathname, open: false });
              setAccountOpen(false);
            };

  useEffect(() => {
    if (!accountOpen) return undefined;
    const onPointerDown = (event) => {
      if (!accountRef.current?.contains(event.target)) setAccountOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

    const avatarInitial = (user?.full_name || user?.email || "A").charAt(0).toUpperCase();
  const toggleLabel = isCompact
    ? drawerOpen ? "Close navigation menu" : "Open navigation menu"
    : railCollapsed ? "Expand sidebar" : "Collapse sidebar";

  function toggleNavigation() {
    if (isCompact) setDrawer({ path: location.pathname, open: !drawerOpen });
    else setRailCollapsed((collapsed) => !collapsed);
  }

  function onSearchSubmit(event) {
    event.preventDefault();
    const term = searchTerm.trim();
    closeDrawer();
    navigate(term ? `/history?q=${encodeURIComponent(term)}` : "/history");
  }

  if (!workspace) {
    return (
      <header className={`top-bar auth-top-bar ${dark ? "top-dark" : ""}`}>
        <button className="top-brand" type="button" onClick={() => navigate("/")} aria-label="AI Interview Preparation System — go home">
          <img className="brand-logo-img" src="/favicon.svg" alt="" aria-hidden="true" />
          <span>AI Interview</span>
        </button>
        <strong>{title}</strong>
        <span className="top-context">AI INTERVIEW PREPARATION SYSTEM</span>
      </header>
    );
  }

  return (
    <>
      <aside id="workspace-sidebar" className={`workspace-sidebar ${railCollapsed ? "is-collapsed" : ""} ${drawerOpen ? "is-open" : ""}`}>
        <div className="sidebar-top-row">
          <button className="sidebar-brand" type="button" title="AI Interview Preparation System" aria-label="AI Interview Preparation System — go to Dashboard" onClick={() => { closeDrawer(); navigate("/"); }}>
            <img className="brand-logo-img" src="/favicon.svg" alt="" aria-hidden="true" />
            <span className="sidebar-brand-copy"><strong>AI Interview</strong><small>PREPARATION SYSTEM</small></span>
          </button>
          <button
            className="menu-toggle sidebar-toggle"
            type="button"
            aria-label={toggleLabel}
            aria-expanded={railCollapsed ? false : true}
            aria-controls="workspace-sidebar"
            title={toggleLabel}
            onClick={toggleNavigation}
          >
            <span className="menu-toggle-bars" aria-hidden="true"><i /><i /><i /></span>
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <span className="sidebar-label">Workspace</span>
          {navItems.map(([label, path, icon]) => {
            const active = isNavActive(path);
            return (
              <button
                className={active ? "active" : ""}
                key={label}
                type="button"
                title={label}
                aria-current={active ? "page" : undefined}
                onClick={() => { closeDrawer(); navigate(path); }}
              >
                <span className="nav-icon" aria-hidden="true">{icon}</span>
                <span className="nav-text">{label}</span>
              </button>
            );
          })}
          <span className="sidebar-label sidebar-label-lower">Support</span>
            {LOWER_NAV_ITEMS.map((item) => {
              const active = isNavActive(item.route);
              return (
                <button
                  key={item.label}
                  type="button"
                  className={active ? "active sidebar-nav-lower" : "sidebar-nav-lower"}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  onClick={() => { closeDrawer(); navigate(item.route); }}
                >
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span className="nav-text">{item.label}</span>
                                </button>
              );
            })}
        </nav>

          <div className={`account-menu-anchor${accountOpen ? " is-open" : ""}`} ref={accountRef}>
            {accountOpen ? (
              <div className="account-menu" id="account-menu" role="menu" aria-label="Account">
                <div className="account-menu-head">
                  <span className="profile-avatar" aria-hidden="true">{avatarInitial}</span>
                  <span className="account-menu-identity">
                    <strong>{user?.full_name || "Your profile"}</strong>
                    <small>{user?.email || "Signed in"}</small>
                  </span>
                </div>
                <p className="account-menu-note">Education details are not collected yet — your name and email are shown as stored on your account.</p>
                <button
                  className="account-menu-item account-menu-logout"
                  type="button"
                  role="menuitem"
                  onClick={() => { setAccountOpen(false); logout(); }}
                >
                  <span aria-hidden="true">↗</span> Log out
                </button>
              </div>
            ) : null}
            <button
              className="sidebar-profile"
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              aria-controls="account-menu"
              title="Account menu"
              onClick={() => setAccountOpen((open) => !open)}
            >
              <span className="profile-avatar" aria-hidden="true">{avatarInitial}</span>
              <span className="profile-copy">
                <strong>{user?.full_name || "Your profile"}</strong>
                <small>{user?.email || "Signed in"}</small>
              </span>
              <span className="profile-caret" aria-hidden="true">▾</span>
            </button>
          </div>
      </aside>
      {isCompact && drawerOpen ? <button className="sidebar-scrim" aria-label="Close navigation" type="button" onClick={closeDrawer} /> : null}
      <header className={`top-bar workspace-top-bar ${dark ? "top-dark" : ""}`}>
        <div className="top-heading"><span>Workspace</span><strong>{title}</strong></div>
        <div className="top-actions">
          <form className="top-search" role="search" onSubmit={onSearchSubmit} title="Search interview history">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search interview history"
              placeholder="Search history"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </form>
          <span
            className="notification-button"
            role="status"
            aria-label="Notifications are not available yet"
            title="Notifications are not available yet"
          >♢</span>
          <button
            className="top-avatar-button"
            type="button"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-controls="account-menu"
            aria-label={`Account menu for ${user?.full_name || user?.email || "your profile"}`}
            title={user?.full_name || user?.email || "Account menu"}
            onClick={() => setAccountOpen((open) => !open)}
          >
            <span className="top-avatar" aria-hidden="true">{avatarInitial}</span>
          </button>
        </div>
      </header>
    </>
  );
}

/* ================= OPTION BOX ================= */

/**
 * Preserved original component; now optionally controlled so page state
 * (the interview configuration) lives in one place instead of per-box.
 */
export function OptionBox({ title, options, value, onChange }) {
  const [internal, setInternal] = useState(options[1]?.value ?? options[0]?.value);
  const selected = value !== undefined ? value : internal;
  const setOption = (next) => {
    if (onChange) onChange(next);
    else setInternal(next);
  };
  return (
    <div className="option-box">
      <h3>{title}</h3>
      <div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={selected === option.value ? "selected" : ""}
            onClick={() => setOption(option.value)}
            aria-pressed={selected === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ================= SCORE CARD ================= */

export function ScoreCard({ title, score, scorePercent }) {
  // scorePercent must be derived from a REAL persisted score by the caller.
  const width = typeof scorePercent === "number" ? `${Math.max(0, Math.min(100, scorePercent))}%` : score;
  return (
    <div className="score-card">
      <span>{title}</span>
      <strong>{score}</strong>
      <div className="score-bar">
        <div style={{ width }}></div>
      </div>
    </div>
  );
}

/* ================= HISTORY CARD ================= */

export function HistoryCard({ date, role, type, score, onViewReport }) {
  const navigate = useNavigate();
  return (
    <div className="history-card">
      <div className="history-date">
        <small>DATE</small>
        <strong>{date}</strong>
      </div>
      <div>
        <small>ROLE</small>
        <strong>{role}</strong>
      </div>
      <div>
        <small>TYPE</small>
        <strong>{type}</strong>
      </div>
      <div className="history-score">
        <small>SCORE</small>
        <strong>{score}</strong>
      </div>
      <button type="button" onClick={() => (onViewReport ? onViewReport() : navigate("/history"))}>
        View Report →
      </button>
    </div>
  );
}
