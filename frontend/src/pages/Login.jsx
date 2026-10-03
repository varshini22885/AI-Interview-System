import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { useAuth } from "../auth/useAuth.js";
import { ErrorBox } from "../components/StateViews.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-page">
      <TopBar title="Sign In" />
      <main className="login-main">
        <div className="login-card">
          <section className="login-promo" aria-label="AI Interview Preparation System">
            <div className="login-promo-brand">
              <img className="brand-logo-img" src="/favicon.svg" alt="" aria-hidden="true" />
              <span>AI Interview<small>PREPARATION SYSTEM</small></span>
            </div>
            <div className="login-promo-copy">
              <p className="eyebrow">PREPARE WITH CONFIDENCE</p>
              <h1>Your AI-Powered<br /><em>Interview Companion</em></h1>
              <p>Practice. Improve. Get Hired.<br />Build your confidence with AI-driven<br />interviews and personalized feedback.</p>
            </div>
            <div className="login-illustration" aria-hidden="true">
              <span className="illustration-glow" />
              <span className="illustration-head"><i /></span>
              <span className="illustration-neck" />
              <span className="illustration-body" />
              <span className="illustration-headset headset-left" />
              <span className="illustration-headset headset-right" />
              <span className="illustration-mic" />
              <span className="illustration-spark spark-one">✦</span>
              <span className="illustration-spark spark-two">·</span>
            </div>
            <div className="login-features">
              <div><span className="feature-icon">◉</span><span><strong>Real-time</strong><small>AI Evaluation</small></span></div>
              <div><span className="feature-icon">⌁</span><span><strong>Industry Specific</strong><small>Questions</small></span></div>
              <div><span className="feature-icon">▤</span><span><strong>Detailed</strong><small>Reports</small></span></div>
            </div>
          </section>

          <section className="login-form-panel">
            <div className="login-form-heading">
              <h1 className="visually-hidden">Sign In</h1>
              <p className="eyebrow">WELCOME BACK</p>
              <h2>Welcome Back</h2>
              <p>Sign in to continue your interview journey</p>
            </div>

            <form className="login-form" onSubmit={onSubmit} noValidate>
              <label htmlFor="login-email">Email Address</label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />

              <label htmlFor="login-password">Password</label>
              <div className="password-field">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  className="password-toggle"
                  type="button"
                  aria-label="Toggle visibility"
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? "◉" : "◌"}
                </button>
              </div>

              <div className="login-options">
                <label className="remember-option">
                  <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
                  <span>Remember me</span>
                </label>
                <span className="forgot-password">Forgot password?</span>
              </div>

              <ErrorBox error={error} />

              <button className="main-button login-submit" type="submit" disabled={pending || !email || !password}>
                {pending ? "Signing in…" : "Sign In →"}
              </button>

              <p className="login-register">Don't have an account? <Link to="/register">Create account</Link></p>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
