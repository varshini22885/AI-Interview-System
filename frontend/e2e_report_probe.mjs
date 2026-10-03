/**
 * TEMPORARY verification probe (not part of the app build).
 * Proves the last unverified UI segment of the user journey: the performance
 * report page. Values are read from the live API first and then asserted against
 * what the real browser renders, so the probe cannot pass on stale/stubbed data.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const FE = process.env.FE_URL || "http://127.0.0.1:5173";
const API = process.env.API_URL || "http://127.0.0.1:8000/api/v1";
const OUT = process.env.OUT_DIR || process.cwd();
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const INTERVIEW_ID = process.env.INTERVIEW_ID;

if (!EMAIL || !PASSWORD || !INTERVIEW_ID) {
  console.error("TEST_EMAIL, TEST_PASSWORD and INTERVIEW_ID are required");
  process.exit(2);
}

const lines = [];
const results = {};
let failures = 0;
const log = (...a) => { const l = a.map(String).join(" "); console.log(l); lines.push(l); };
function record(key, ok, detail = "") {
  results[key] = { ok: Boolean(ok), detail };
  if (!ok) failures += 1;
  log(`${ok ? "PASS" : "FAIL"} | ${key} | ${detail}`);
}

// ---------- 1. ground truth from the live API ----------
const login = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const { access_token } = await login.json();
const reportRes = await fetch(`${API}/reports/${INTERVIEW_ID}`, { headers: { Authorization: `Bearer ${access_token}` } });
const expected = await reportRes.json();
record("PERSISTED REPORT VIA API", reportRes.status === 200, `HTTP ${reportRes.status} | ${JSON.stringify({ overall: expected.overall_score, technical: expected.technical_score, communication: expected.communication_score, answers: expected.total_questions_answered, status: expected.status })}`);
if (reportRes.status !== 200) process.exit(2);

const narrativeCount = (text) => (text ? String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean).length : 0);

// ---------- 2. real browser ----------
const browser = await chromium.launch({
  channel: "msedge",
  headless: process.env.HEADLESS === "1",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["camera", "microphone"],
  baseURL: FE,
});
const page = await context.newPage();
const responses = [];
const consoleErrors = [];
const pageErrors = [];
page.on("response", (r) => {
  if (r.url().includes("/api/")) responses.push({ method: r.request().method(), url: r.url(), status: r.status(), at: new Date().toISOString() });
});
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 240)); });
page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e).slice(0, 240)));

await page.goto(`${FE}/login`, { waitUntil: "networkidle", timeout: 60000 });
await page.fill("#login-email", EMAIL);
await page.fill("#login-password", PASSWORD);
await page.click("button.login-submit");
const loggedIn = await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45000 }).then(() => true).catch(() => false);
record("LOGIN VIA UI FORM", loggedIn, `url=${page.url()}`);
if (!loggedIn) { await browser.close(); process.exit(1); }

// ---------- 3. cold deep-link into the report (session restored from the cookie) ----------
await page.goto(`${FE}/report/${INTERVIEW_ID}`, { waitUntil: "networkidle", timeout: 60000 });
await page.locator(".report-score-ring").first().waitFor({ timeout: 30000 }).catch(() => {});
const container = page.locator(".report-container");
const body = (await container.innerText().catch(() => "")) || "";

const domOverall = (await page.locator(".report-score-ring strong").first().innerText().catch(() => "")).trim();
record("REPORT RENDERS ON COLD LOAD", domOverall !== "", `url=${page.url()}`);
record("OVERALL SCORE MATCHES API", domOverall === String(expected.overall_score), `dom=${domOverall} api=${expected.overall_score}`);
record("INTERVIEW COMPLETE BANNER", body.includes("INTERVIEW COMPLETE"), "");

const metricMap = {};
for (const metric of await page.locator(".report-metric").all()) {
  const text = (await metric.innerText().catch(() => "")).split("\n").map((s) => s.trim()).filter(Boolean);
  if (text.length >= 2) metricMap[text[0]] = text[1];
}
const metricChecks = [
  ["Communication", expected.communication_score],
  ["Technical Knowledge", expected.technical_score],
  ["Problem Solving", expected.problem_solving_score],
  ["Confidence", expected.confidence_score],
];
for (const [label, value] of metricChecks) {
  const rendered = metricMap[label];
  const want = typeof value === "number" ? `${value}%` : "Not provided";
  record(`METRIC ${label.toUpperCase()} MATCHES API`, rendered === want, `dom=${rendered} api=${value}`);
}

const answersCopy = `Based on ${expected.total_questions_answered} evaluated answer${expected.total_questions_answered === 1 ? "" : "s"}.`;
record("ANSWER COUNT COPY MATCHES API", body.includes(answersCopy), `expected="${answersCopy}"`);

for (const [section, text] of [["STRENGTHS", expected.strengths], ["AREAS FOR IMPROVEMENT", expected.areas_for_improvement], ["RECOMMENDATIONS", expected.recommendations]]) {
  if (!text) continue;
  const rendered = await page.locator(".report-feedback-card", { hasText: section }).locator("li, p").count();
  record(`${section} LINES RENDERED`, rendered === narrativeCount(text), `dom_items=${rendered} api_lines=${narrativeCount(text)}`);
}


// ---------- 4. history -> report navigation (client-side) ----------
await page.goto(`${FE}/history`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".history-table-row").first().waitFor({ timeout: 30000 }).catch(() => {});
const row = page.locator(".history-table-row", { hasText: "Software Engineer" }).first();
const rowVisible = await row.isVisible().catch(() => false);
const rowText = rowVisible ? (await row.innerText()).replace(/\s+/g, " ").slice(0, 160) : "";
record("HISTORY LISTS COMPLETED INTERVIEW", rowVisible && /Completed/.test(rowText), `row="${rowText}"`);
if (rowVisible) {
  await row.locator(".history-report-button").first().click();
  const navigated = await page.waitForURL((u) => u.pathname.startsWith("/report/"), { timeout: 20000 }).then(() => true).catch(() => false);
  const scoreAfterNav = (await page.locator(".report-score-ring strong").first().innerText().catch(() => "")).trim();
  record("HISTORY -> REPORT NAVIGATION", navigated && scoreAfterNav !== "", `url=${page.url()} score=${scoreAfterNav}`);
}

await page.screenshot({ path: path.join(OUT, "shot-15-report-page.png"), fullPage: true });

// ---------- 5. transport hygiene ----------
const refreshResponses = responses.filter((r) => r.url.includes("/auth/refresh"));
record("SESSION RESTORED BY COOKIE REFRESH", refreshResponses.some((r) => r.status === 200), `POST /auth/refresh statuses=${JSON.stringify(refreshResponses.map((r) => r.status))}`);
const fivexx = responses.filter((r) => r.status >= 500);
record("NO 5xx DURING REPORT FLOW", fivexx.length === 0, fivexx.length ? JSON.stringify(fivexx) : "no 5xx responses");
record("NO PAGE ERRORS", pageErrors.length === 0, pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : "none");
// A brand-new browser context has no refresh cookie yet, so the boot session probe
// legitimately returns 401 and browsers log every failed fetch as a console error.
const unexpectedConsoleErrors = consoleErrors.filter((t) => !/401 \(Unauthorized\)/.test(t));
record("NO UNEXPECTED CONSOLE ERRORS", unexpectedConsoleErrors.length === 0, `boot 401 probes=${consoleErrors.length - unexpectedConsoleErrors.length} | unexpected=${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`);
const reportCalls = responses.filter((r) => /\/reports\//.test(r.url));
record("REPORT FETCH OBSERVED", reportCalls.some((r) => r.status === 200), JSON.stringify(reportCalls.map((r) => r.status)));

await browser.close();
fs.writeFileSync(path.join(OUT, "e2e-report-probe.json"), JSON.stringify({ results, expected, responses }, null, 2));
fs.writeFileSync(path.join(OUT, "e2e-report-probe.log"), lines.join("\n"));
log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
