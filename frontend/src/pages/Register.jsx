import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TopBar } from "../App.jsx";
import { useAuth } from "../auth/useAuth.js";
import { ErrorBox } from "../components/StateViews.jsx";

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError({ code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." });
      return;
    }
    if (password !== confirmPassword) {
      setError({ code: "PASSWORD_MISMATCH", message: "Passwords do not match." });
      return;
    }
    setPending(true);
    try {
      await register(email.trim(), fullName.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-page register-page">
      <TopBar title="Create Account" />
      <main className="login-main">
        <div className="login-card">
          <section className="login-promo register-promo" aria-label="AI Interview Preparation System">
            <div className="login-promo-brand">
              <img className="brand-logo-img" src="/favicon.svg" alt="" aria-hidden="true" />
              <span>AI Interview<small>PREPARATION SYSTEM</small></span>
            </div>
            <div className="login-promo-copy">
              <p className="eyebrow">YOUR NEXT OPPORTUNITY STARTS HERE</p>
              <h1>Start Your<br /><em>Career Journey</em></h1>
              <p>Create your account and take the first<br />step towards your dream job with<br />AI-powered interview preparation.</p>
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
            <div className="register-features login-features">
              <div><span className="feature-icon">◉</span><span><strong>Build Your</strong><small>Profile</small></span></div>
              <div><span className="feature-icon">⌁</span><span><strong>Upload</strong><small>Resume</small></span></div>
              <div><span className="feature-icon">▤</span><span><strong>Start</strong><small>Practicing</small></span></div>
            </div>
          </section>

          <section className="login-form-panel register-form-panel">
            <div className="login-form-heading">
              <h1 className="visually-hidden">Create Account</h1>
              <p className="eyebrow">GET STARTED</p>
              <h2>Create Account</h2>
              <p>Join AI Interview Preparation System</p>
            </div>

            <form className="login-form register-form" onSubmit={onSubmit} noValidate>
              <label htmlFor="reg-name">Full Name</label>
              <input
                id="reg-name"
                type="text"
                autoComplete="name"
                placeholder="Your full name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />

              <label htmlFor="reg-email">Email Address</label>
              <input
                id="reg-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />

              <label htmlFor="reg-password">Password</label>
              <div className="password-field">
                <input
                  id="reg-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button className="password-toggle" type="button" aria-label="Toggle visibility" onClick={() => setShowPassword((visible) => !visible)}>
                  {showPassword ? "◉" : "◌"}
                </button>
              </div>

              <label htmlFor="reg-confirm-password">Confirm Password</label>
              <div className="password-field">
                <input
                  id="reg-confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <button className="password-toggle" type="button" aria-label="Toggle visibility" onClick={() => setShowConfirmPassword((visible) => !visible)}>
                  {showConfirmPassword ? "◉" : "◌"}
                </button>
              </div>

              <ErrorBox error={error} />

              <button className="main-button login-submit" type="submit" disabled={pending || !email || !password || !fullName || !confirmPassword}>
                {pending ? "Creating account…" : "Create Account →"}
              </button>

              <p className="login-register">Already have an account? <Link to="/login">Login</Link></p>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
