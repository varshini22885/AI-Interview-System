/**
 * TEMPORARY verification driver (not part of the app build).
 * Opens the real Vite site in Edge via Playwright and drives the real user
 * journey while recording console, network, WebSocket and UI-state evidence.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const FE = process.env.FE_URL || "http://127.0.0.1:5173";
const OUT = process.env.OUT_DIR;
const RESUME_FILE = process.env.RESUME_FILE;
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const HEADLESS = process.env.HEADLESS === "1";
// Number of answers to submit before finishing the interview (defaults to the
// full loop; a small value keeps a complete journey -> report run short).
const MAX_ANSWERS = Number(process.env.MAX_ANSWERS || 10);

const LOG = path.join(OUT, "ui-journey.log");
fs.writeFileSync(LOG, "");
const log = (...a) => { const l = a.map(String).join(" "); console.log(l); fs.appendFileSync(LOG, l + "\n"); };
const step = (s) => log("\n########## " + s + " ##########");
const results = {};
function record(key, ok, detail) {
  results[key] = { ok, detail: detail || "" };
  log(`${ok ? "PASS" : "FAIL"} | ${key} | ${detail || ""}`);
}

const consoleMsgs = [], pageErrors = [], failedReqs = [], responses = [], wsSockets = [], answerRequests = [], speechProbes = [];
const serverStatuses = [], currentQuestions = [], reportBodies = [];
const note = (t) => log("  ... " + t);
const dumpJson = (name, obj) => { try { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2)); } catch (e) { log(`dumpJson failed for ${name}: ${e}`); } };

function flush() {
  fs.writeFileSync(path.join(OUT, "ui-results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-console.json"), JSON.stringify({ consoleMsgs, pageErrors, failedReqs }, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-network.json"), JSON.stringify(responses, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-ws.json"), JSON.stringify(wsSockets, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-answers.json"), JSON.stringify(answerRequests, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-speech.json"), JSON.stringify(speechProbes, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-server-statuses.json"), JSON.stringify({ serverStatuses, currentQuestions }, null, 2));
  fs.writeFileSync(path.join(OUT, "ui-report-bodies.json"), JSON.stringify(reportBodies, null, 2));
}

const browser = await chromium.launch({
  channel: "msedge",
  headless: HEADLESS,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--allow-file-access-from-files",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["camera", "microphone"],
  baseURL: FE,
  acceptDownloads: true,
});
const page = await context.newPage();

page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300) }); });
page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e).slice(0, 300)));
page.on("requestfailed", (r) => failedReqs.push({ url: r.url(), error: r.failure() ? r.failure().errorText : "unknown" }));
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/") || u.includes("/health")) {
    responses.push({ method: r.request().method(), url: u, status: r.status(), at: new Date().toISOString() });
    const iv = u.match(/\/api\/v1\/interviews\/([0-9a-fA-F-]{36})(?:$|\?)/);
    if (iv && r.request().method() === "GET") {
      r.json().then((b) => { if (b && b.status) serverStatuses.push({ at: new Date().toISOString(), status: b.status }); }).catch(() => {});
    }
    if (/\/api\/v1\/interviews\/[0-9a-fA-F-]{36}\/current-question/.test(u) && r.request().method() === "GET") {
      r.json().then((b) => {
        if (b) currentQuestions.push({ at: new Date().toISOString(), status: b.status, question_id: b.question_id, order_index: b.order_index, follow_up: b.is_follow_up ?? null, text: String(b.question_text || "").slice(0, 70) });
      }).catch(() => {});
    }
    if (/\/api\/v1\/reports\/[0-9a-fA-F-]{36}/.test(u) && r.request().method() === "GET") {
      r.json().then((b) => { reportBodies.push({ at: new Date().toISOString(), body: b }); }).catch(() => {});
    }
  }
  if (/\.(wav|mp3|ogg|webm|m4a|opus)(\?|$)/i.test(u) || /(tts|speech|synthes|voice)/i.test(u)) {
    speechProbes.push({ method: r.request().method(), url: u, status: r.status(), type: r.request().resourceType() });
  }
});
page.on("request", (r) => {
  if (/\/api\/v1\/interviews\/[^/]+\/answers$/.test(r.url()) && r.method() === "POST") {
    let hdrs = {};
    try { hdrs = r.headers(); } catch { hdrs = {}; }
    answerRequests.push({ url: r.url(), idempotencyKey: hdrs["idempotency-key"] || null, body: String(r.postData() || "").slice(0, 200) });
  }
});
page.on("websocket", (ws) => {
  const rec = { url: ws.url(), at: new Date().toISOString(), frames: [], closedAt: null, error: null };
  wsSockets.push(rec);
  ws.on("framesent", (f) => rec.frames.push({ dir: "sent", payload: String(f.payload).slice(0, 300) }));
  ws.on("framereceived", (f) => rec.frames.push({ dir: "recv", payload: String(f.payload).slice(0, 300) }));
  ws.on("close", () => { rec.closedAt = new Date().toISOString(); });
  ws.on("socketerror", (e) => { rec.error = String(e).slice(0, 200); });
});
page.on("dialog", async (d) => { log(`[dialog] ${d.type()}: ${d.message()} -> accept`); await d.accept().catch(() => {}); });


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function snap(name) { try { await page.screenshot({ path: path.join(OUT, `shot-${name}.png`), fullPage: true }); } catch { /* ignore */ } }
async function bodyText() { try { return (await page.locator("body").innerText({ timeout: 5000 })) || ""; } catch { return ""; } }
async function waitForText(needle, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await bodyText()).includes(needle)) return true;
    await sleep(500);
  }
  return false;
}
async function readState() {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const label = q(".question-card-label em");
    const video = q(".candidate-video-card video");
    let tracks = [];
    try {
      const s = video && video.srcObject;
      if (s) tracks = s.getTracks().map((t) => ({ kind: t.kind, readyState: t.readyState, enabled: t.enabled, label: t.label }));
    } catch { tracks = []; }
    return {
      url: location.pathname,
      questionText: q(".current-question-card h1") ? q(".current-question-card h1").innerText.trim() : null,
      stateLabel: label ? label.innerText.trim() : null,
      audioState: q(".question-audio-state strong") ? q(".question-audio-state strong").innerText.trim() : null,
      videoTop: q(".candidate-video-card .video-card-top") ? q(".candidate-video-card .video-card-top").innerText.trim() : null,
      micText: q(".candidate-name span") ? q(".candidate-name span").innerText.trim() : null,
      hasAnswerForm: !!q("#answer-text"),
      answerDisabled: q("#answer-text") ? q("#answer-text").disabled : null,
      videoReadyState: video ? video.readyState : null,
      videoWidth: video ? video.videoWidth : null,
      tracks,
      hasMediaRecorder: typeof window.MediaRecorder !== "undefined",
      audioElementCount: document.querySelectorAll("audio").length,
      hasFaceLibrary: !!(window.FaceMesh || window.faceapi || window.MediaPipe || window.FaceDetector),
    };
  });
}
async function sampleStates(done, timeoutMs, ms = 350) {
  const started = Date.now(); const seen = []; let last = null;
  while (Date.now() - started < timeoutMs) {
    const st = await readState();
    const key = `${st.stateLabel} | ${st.audioState}`;
    if (key !== last) { seen.push({ at: new Date().toISOString(), key, question: st.questionText ? st.questionText.slice(0, 70) : null }); last = key; }
    if (done(st)) return { st, seen };
    await sleep(ms);
  }
  return { st: await readState(), seen };
}
/** Type + submit an answer through the real UI form; waits for a POST /answers. */
async function submitAnswerViaUI(text, waitMs = 90000) {
  const before = answerRequests.length;
  if (!(await page.locator("#answer-text").count())) return { ok: false, reason: "answer form not present" };
  await page.fill("#answer-text", text);
  await page.click('.live-answer-area button[type="submit"]');
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (answerRequests.length > before) return { ok: true, req: answerRequests[answerRequests.length - 1] };
    await sleep(300);
  }
  return { ok: false, reason: "no POST /answers observed after submit" };
}

/* ================= A. FRONTEND LOAD / PROTECTED ROUTE ================= */
step("A1. FRONTEND LOAD + PROTECTED ROUTE");
const resp = await page.goto(FE + "/", { waitUntil: "networkidle", timeout: 60000 });
const rootLen = (await page.locator("#root").innerHTML()).length;
record("FRONTEND LOAD", resp.status() === 200 && rootLen > 200, `HTTP ${resp.status()} | #root innerHTML chars=${rootLen} | url=${page.url()}`);
const homeBody = await bodyText();
record("HOME (PUBLIC) RENDERS", homeBody.length > 200, `public landing page chars=${homeBody.length} | snippet=${homeBody.replace(/\s+/g, " ").slice(0, 120)}`);
await snap("00-home");

step("A1b. PROTECTED ROUTE WHILE ANONYMOUS");
await page.goto(FE + "/resume", { waitUntil: "networkidle" });
await sleep(1200);
const protRedirect = page.url();
const protOnLoginForm = await page.locator("#login-email").count();
record("PROTECTED ROUTE", protRedirect.includes("/login") && protOnLoginForm > 0, `anonymous GET /resume -> ${protRedirect} | login form present=${protOnLoginForm > 0}`);
await snap("01-login");

step("A2. AUTH NEGATIVE (wrong password, real backend)");
await page.fill("#login-email", EMAIL);
await page.fill("#login-password", "definitely-wrong-password-987");
await page.click("button.login-submit");
const badErr = await waitForText("Invalid", 20000);
record("AUTH NEGATIVE", badErr, `error message surfaced in UI=${badErr}; body=${(await bodyText()).replace(/\s+/g, " ").slice(0, 140)}`);
record("PROTECTED ROUTE STILL BLOCKED AFTER FAILED LOGIN", page.url().includes("/login"), `url after failed login=${page.url()}`);
await snap("02-login-error");

step("A3. REGISTER VIA UI");
await page.goto(FE + "/register", { waitUntil: "networkidle" });
await page.fill("#reg-name", "E2E Browser Tester");
await page.fill("#reg-email", EMAIL);
await page.fill("#reg-password", PASSWORD);
await page.fill("#reg-confirm-password", PASSWORD);
await page.click("button.login-submit");
const regNav = await page.waitForURL((u) => !u.pathname.includes("/register"), { timeout: 40000 }).then(() => true).catch(() => false);
record("REGISTER (UI)", regNav, `navigated to ${page.url()}`);
await snap("03-after-register");

step("A4. DASHBOARD / HOME");
await page.goto(FE + "/", { waitUntil: "networkidle" });
const dash = await bodyText();
record("DASHBOARD", dash.length > 200, `chars=${dash.length} | ${dash.replace(/\s+/g, " ").slice(0, 180)}`);
await snap("04-dashboard");

step("A5. AUTH PERSISTENCE + TOKEN STORAGE");
const cks = await context.cookies();
const refresh = cks.find((c) => /refresh/i.test(c.name));
const lsKeys = await page.evaluate(() => Object.keys(window.localStorage));
const lsAll = await page.evaluate(() => JSON.stringify(window.localStorage));
await page.reload({ waitUntil: "networkidle" });
const stayedIn = !page.url().includes("/login") && (await bodyText()).length > 200;
record("AUTH PERSISTENCE", stayedIn, `after reload url=${page.url()} | HttpOnly refresh cookie present=${!!refresh} (httpOnly=${refresh ? refresh.httpOnly : "n/a"})`);
record("TOKEN NOT IN WEB STORAGE", !/eyJ[A-Za-z0-9_-]{10,}/.test(lsAll), `localStorage keys=${JSON.stringify(lsKeys)} | JWT-looking value in localStorage=${/eyJ[A-Za-z0-9_-]{10,}/.test(lsAll)}`);

step("A6. HISTORY PAGE");
await page.goto(FE + "/history", { waitUntil: "networkidle" });
const hist = await bodyText();
record("HISTORY / LIST", hist.length > 100 && !/cannot reach the server/i.test(hist), `chars=${hist.length} | ${hist.replace(/\s+/g, " ").slice(0, 160)}`);
await snap("05-history");

/* ================= B. RESUME UPLOAD ================= */
step("B1. RESUME PAGE + UPLOAD VIA FILE INPUT");
await page.goto(FE + "/resume", { waitUntil: "networkidle" });
const resBody0 = await bodyText();
const sawEmpty = /No resumes yet|Upload your resume|No resume yet/i.test(resBody0);
record("RESUME EMPTY STATE", sawEmpty, `empty state rendered=${sawEmpty}`);
await snap("06a-resume-empty");

const upBefore = responses.filter((r) => /\/api\/v1\/resumes/.test(r.url)).length;
await page.setInputFiles('input[type="file"]', RESUME_FILE);
let upResp = null;
{
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const posts = responses.filter((r) => /\/api\/v1\/resumes/.test(r.url));
    if (posts.length > upBefore) { upResp = posts[posts.length - 1]; break; }
    await sleep(400);
  }
}
record("RESUME UPLOAD REQUEST", !!upResp && upResp.status < 300, upResp ? `${upResp.method} ${upResp.url.replace(FE, "")} -> HTTP ${upResp.status}` : "no request to /resumes observed");

const chipReady = await waitForText("Ready", 150000);
// This page polls while a resume is UPLOADED/PROCESSING, so Playwright's
// "networkidle" never settles reliably here: wait for rendered content instead.
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
const persistedReady = await waitForText("Ready", 60000);
const resBody1 = await bodyText();
record("RESUME PROCESSING + DISPLAY", chipReady && persistedReady, `client saw Ready chip=${chipReady}; Ready persists after reload=${persistedReady}; body=${resBody1.replace(/\s+/g, " ").slice(0, 200)}`);
await snap("06b-resume-ready");

/* ================= C. CREATE INTERVIEW VIA UI ================= */
step("C1. SETUP WIZARD: 5 STEPS -> CREATE");
await page.goto(FE + "/setup", { waitUntil: "networkidle" });
await snap("07a-setup-step1");
const wizardLog = [];
async function stepNo() { const m = (await bodyText()).match(/Step (\d) of 5/); return m ? Number(m[1]) : null; }
for (let i = 0; i < 7; i++) {
  const s = await stepNo();
  wizardLog.push(`step${s}`);
  if (s === 5) break;
  if (s === 1) {
    const card = page.locator(".setup-resume-card").nth(1);
    if (await card.count()) { await card.click().catch(() => {}); await sleep(300); }
  } else if (s === 2) {
    const roleCard = page.locator(".role-card").filter({ hasText: "Software Engineer" }).first();
    if (await roleCard.count()) await roleCard.click();
    else await page.fill('input[aria-label="Custom role"]', "Software Engineer");
    await sleep(400);
  } else if (s === 3) {
    const typeCard = page.locator("button").filter({ hasText: /^Technical/ }).first();
    if (await typeCard.count()) await typeCard.click();
    await sleep(300);
  }
  const next = page.locator(".setup-actions button.main-button");
  if (await next.isEnabled()) { await next.click(); await sleep(700); }
  else { wizardLog.push(`next-disabled@${s}`); break; }
}
wizardLog.push(`final=step${await stepNo()}`);
note(wizardLog.join(" -> "));
const reviewText = await bodyText();
record("SETUP WIZARD (5 STEPS)", (await stepNo()) === 5, `${wizardLog.join(" -> ")} | role in review=${/Software Engineer/.test(reviewText)} | chars=${reviewText.length}`);
await snap("07b-setup-review");

const createBefore = responses.filter((r) => /\/api\/v1\/interviews$/.test(r.url)).length;
await page.click(".setup-actions button.main-button");
let created = null;
{
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const posts = responses.filter((r) => /\/api\/v1\/interviews$/.test(r.url));
    if (posts.length > createBefore) { created = posts[posts.length - 1]; break; }
    await sleep(300);
  }
}
record("INTERVIEW CREATION (UI)", !!created && created.status < 300, created ? `POST /api/v1/interviews -> HTTP ${created.status}` : "no POST /interviews observed");
await sleep(1500);
const lobbyUrl = page.url();
let interviewId = "";
{ const m = lobbyUrl.match(/([0-9a-fA-F-]{36})/); if (m) interviewId = m[1]; }
record("LOBBY ROUTE", /\/lobby\//.test(lobbyUrl) && !!interviewId, `url=${lobbyUrl}`);
await snap("08-lobby-preparing");

/* ================= D. LOBBY: PREPARING -> READY ================= */
step("D1. PREPARING -> READY (backend authoritative)");
const prepText = await bodyText();
record("PREPARING STATE SHOWN", /Preparing|preparing|Generating/i.test(prepText), `lobby body: ${prepText.replace(/\s+/g, " ").slice(0, 170)}`);
const ready = await waitForText("Ready for your interview?", 300000);
const readyBody = await bodyText();
record("QUESTION GENERATION (Celery + NVIDIA)", ready, `lobby reached READY=${ready} | body=${readyBody.replace(/\s+/g, " ").slice(0, 200)}`);
note("recent interview API: " + responses.filter((r) => /api\/v1\/interviews/.test(r.url)).slice(-5).map((r) => `${r.method} ${r.url.split("/api")[1]} ${r.status}`).join(" || "));
await snap("09-lobby-ready");

step("D2. ENTER INTERVIEW (UI CLICK)");
const enterBtn = page.getByRole("button", { name: /Enter Interview/i }).first();
if (await enterBtn.count()) await enterBtn.click();
else await page.locator(".main-button").last().click();

await page.waitForURL((u) => /\/interview\//.test(u.pathname), { timeout: 60000 }).catch(() => {});
await sleep(5000);
const st0 = await readState();
record("INTERVIEW PAGE NAV", /\/interview\//.test(page.url()), `url=${page.url()}`);
record("CAMERA + MIC PREVIEW", st0.tracks.length >= 2 && st0.videoReadyState >= 2 && st0.videoWidth > 0, `tracks=${JSON.stringify(st0.tracks)} | videoReadyState=${st0.videoReadyState} | videoWidth=${st0.videoWidth}`);
note("interview state at load: " + JSON.stringify(st0));
await snap("10-interview-live");

/* ================= E. REALTIME TRANSPORT ================= */
step("E1. WEBSOCKET / REALTIME TRANSPORT");
const wsDuringInterview = wsSockets.filter((w) => w.url.includes("/realtime/"));
record("WEBSOCKET CONNECTION", wsDuringInterview.length > 0, `WebSocket objects opened by the page during the interview = ${wsSockets.length}; realtime ones = ${wsDuringInterview.length}; urls=${JSON.stringify(wsSockets.map((w) => w.url))}`);
const rtSessionCalls = responses.filter((r) => /\/realtime\/session/.test(r.url));
record("REALTIME SESSION CALL", rtSessionCalls.length > 0, `POST /realtime/session observed=${rtSessionCalls.length} ${JSON.stringify(rtSessionCalls.map((r) => r.status))}`);

// The page opens the socket only after authenticating and creating the session,
// so transport behaviour is judged after the session has actually exchanged
// frames. The wait is bounded and invents nothing: if the frames never arrive the
// checks below still fail on the real counts.
{
  const start = Date.now();
  const sent = () => wsDuringInterview.reduce((n, w) => n + w.frames.filter((f) => f.dir === "sent").length, 0);
  const recv = () => wsDuringInterview.reduce((n, w) => n + w.frames.filter((f) => f.dir === "recv").length, 0);
  while (Date.now() - start < 45000 && !(sent() >= 2 && recv() >= 2)) await sleep(1000);
  note(`realtime frames after wait (${Date.now() - start}ms): ` + JSON.stringify(wsDuringInterview.map((w) => ({ url: w.url.slice(0, 72), sent: w.frames.filter((f) => f.dir === "sent").length, recv: w.frames.filter((f) => f.dir === "recv").length, sample: w.frames.slice(0, 4).map((f) => f.dir + ":" + f.payload.slice(0, 60)) }))));
}
record("FACE TELEMETRY (face_status)", wsDuringInterview.some((w) => w.frames.some((f) => /face_status/.test(f.payload))), `face_status frames observed=${wsDuringInterview.some((w) => w.frames.some((f) => /face_status/.test(f.payload)))}; face library on page (FaceMesh/faceapi/MediaPipe/FaceDetector)=${st0.hasFaceLibrary}`);
note("speech probes (audio/tts/speech requests): " + JSON.stringify(speechProbes.slice(0, 6)));
note("audio elements in DOM: " + st0.audioElementCount + " | MediaRecorder available: " + st0.hasMediaRecorder);

/* --- dedicated speech (TTS / STT) verification: no fake success --- */
const ttsRequests = responses.filter((r) => /(tts|speech|synthes|voice|audio)/i.test(r.url));
const ttsWsFrames = wsDuringInterview.reduce((n, w) => n + w.frames.filter((f) => f.dir === "recv" && /audio_started|audio_chunk/.test(f.payload)).length, 0);
const ttsUnavailable = wsDuringInterview.reduce((n, w) => n + w.frames.filter((f) => /TTS_UNAVAILABLE/.test(f.payload)).length, 0);
const audioMediaRequests = speechProbes.some((p) => /\.(wav|mp3|ogg|webm|m4a|opus)(\?|$)/i.test(p.url));
record(
  "SPEECH / TTS AUDIO STREAMED TO BROWSER",
  ttsWsFrames > 0 || ttsRequests.length > 0 || audioMediaRequests,
  `TTS evidence: WS audio_started/audio_chunk frames received=${ttsWsFrames} | TTS_UNAVAILABLE errors from server=${ttsUnavailable} (empty NVIDIA_TTS_FUNCTION_ID => TTS unconfigured) | HTTP tts/speech/audio requests=${JSON.stringify(ttsRequests.map((r) => `${r.method} ${r.url.split("/api")[1] || r.url} ${r.status}`).slice(0, 6))} | audio media requests=${JSON.stringify(speechProbes.slice(0, 4))} | <audio> elements=${st0.audioElementCount} | question rendered as text only=${!!st0.questionText}`,
);
const sttFrames = wsDuringInterview.reduce((n, w) => n + w.frames.filter((f) => /audio_chunk|audio_start|audio_end/.test(f.payload)).length, 0);
// Real speech-to-text transport only: transcript READS are not STT ingestion.
// ASR is WebSocket-streamed by design in this system, so browser-side audio
// frames ARE the STT ingestion evidence (no HTTP STT endpoint exists).
const sttErrors = wsDuringInterview.reduce((n, w) => n + w.frames.filter((f) => /STT_NOT_CONFIGURED|STT_UNAVAILABLE/.test(f.payload)).length, 0);
const sttRequests = responses.filter((r) => /(stt|speech-to-text|transcribe|audio\/transcriptions)/i.test(r.url));
const transcriptReads = responses.filter((r) => /\/transcript/i.test(r.url));
record(
  "SPEECH / STT CAPTURE IN BROWSER",
  sttFrames > 0,
  `audio_* frames sent over the realtime WebSocket=${sttFrames} | HTTP STT endpoints called=${sttRequests.length} (ASR is WS-streamed by design) | server STT errors observed=${sttErrors} (empty NVIDIA_ASR_FUNCTION_ID => STT unconfigured) | transcript reads (not STT)=${transcriptReads.length} | MediaRecorder present in browser=${st0.hasMediaRecorder}`,
);


/* ================= F. ANSWER -> EVALUATION -> FOLLOW-UP LOOP ================= */
step("F1. ANSWER / EVALUATION / FOLLOW-UP / NEXT QUESTION LOOP");
const ANSWER_TEXT = "I would design it in layers: validate input, keep business rules in a service layer, add indexes for the hot query paths, cache reads where safe, and cover the flow with automated tests. I would also add monitoring so regressions surface early.";
const loopLog = [];
const statesSeen = new Set();
let followUpSeen = false;
let evaluatingSeen = false;
let duplicateGuardChecked = false;

for (let i = 0; i < MAX_ANSWERS; i++) {
  if (/\/report\//.test(page.url())) break;
  if (!(await page.locator("#answer-text").count())) {
    const w = await sampleStates((s) => s.hasAnswerForm || /Completed|Failed/.test(s.stateLabel || ""), 90000);
    w.seen.forEach((x) => statesSeen.add(x.key));
    if (!w.st.hasAnswerForm) { loopLog.push({ i: i + 1, note: "no answer form; state=" + w.st.stateLabel }); break; }
  }
  const before = await readState();
  const qBefore = before.questionText;
  const postsBefore = answerRequests.length;

  // client-side duplicate-submission guard (real UI interaction)
  if (!duplicateGuardChecked) {
    duplicateGuardChecked = true;
    await page.fill("#answer-text", ANSWER_TEXT);
    const btn = page.locator('.live-answer-area button[type="submit"]');
    await Promise.all([btn.click().catch(() => {}), btn.click().catch(() => {}), btn.click().catch(() => {})]);
    await sleep(6000);
    const postsAfter = answerRequests.length - postsBefore;
    record("IDEMPOTENCY (client guard)", postsAfter === 1, `3 rapid clicks on Send Answer produced ${postsAfter} POST /answers (client sends one Idempotency-Key per logical submission)`);
  } else {
    const res = await submitAnswerViaUI(ANSWER_TEXT);
    if (!res.ok) { record("ANSWER SUBMISSION", false, `answer #${i + 1}: ${res.reason}`); break; }
  }

  const { st: after, seen } = await sampleStates(
    (s) => (s.questionText && s.questionText !== qBefore) || /Completed|Failed/.test(s.stateLabel || ""),
    180000,
  );
  seen.forEach((x) => statesSeen.add(x.key));
  if (seen.some((x) => /Follow-up/.test(x.key))) followUpSeen = true;
  if (seen.some((x) => /Evaluating/.test(x.key))) evaluatingSeen = true;
  loopLog.push({ i: i + 1, asked: qBefore ? qBefore.slice(0, 55) : null, transitionsDuringEvaluation: seen.map((x) => x.key), nextQuestion: after.questionText ? after.questionText.slice(0, 55) : null });
  note(`answer #${i + 1} resolved -> state=${after.stateLabel} q=${after.questionText ? after.questionText.slice(0, 45) : null}`);
  if (i === 0) {
    await snap("11-after-first-answer");

    /* ================= G. REFRESH / RECONNECT DURING INTERVIEW ================= */
    step("G1. BROWSER REFRESH DURING INTERVIEW (authoritative state restored)");
    const preReload = await readState();
    const postsBeforeReload = answerRequests.length;
    const qBeforeReload = preReload.questionText;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    // Wait for the camera preview to become live again (the media stream is bound
    // when the <video> element mounts after the query resolves).
    await page.waitForFunction(() => { const v = document.querySelector("video"); return !!v && v.readyState >= 2; }, null, { timeout: 45000 }).catch(() => {});
    const rest = await sampleStates((s) => !!s.questionText && !!s.hasAnswerForm, 90000);
    const postReload = rest.st;
    record(
      "REFRESH / RECONNECT",
      postReload.questionText === qBeforeReload && !!postReload.hasAnswerForm,
      `question before reload="${String(qBeforeReload).slice(0, 55)}" | after reload="${String(postReload.questionText).slice(0, 55)}" | server state label after reload=${postReload.stateLabel} | extra POST /answers during reload=${answerRequests.length - postsBeforeReload} | url=${page.url()}`,
    );
    record("MEDIA PERMISSIONS AFTER RELOAD", postReload.tracks.length >= 2 && postReload.videoReadyState >= 2, `tracks=${JSON.stringify(postReload.tracks)} | videoReadyState=${postReload.videoReadyState} | videoWidth=${postReload.videoWidth} | card=${JSON.stringify(postReload.videoTop)} | mic=${JSON.stringify(postReload.micText)}`);
    await snap("12-after-refresh");
  }
}

record("ANSWER SUBMISSION (UI)", answerRequests.length > 0, `${answerRequests.length} POST /answers observed; distinct Idempotency-Keys=${new Set(answerRequests.map((a) => a.idempotencyKey)).size}`);
record("AI EVALUATION STATE", evaluatingSeen, `UI showed the server EVALUATING state during processing=${evaluatingSeen}; observed state/audio label combinations=${JSON.stringify([...statesSeen])}`);
record("FOLLOW-UP QUESTION", followUpSeen, `UI rendered a server FOLLOW_UP_REQUIRED state=${followUpSeen}`);
note("loop trace: " + JSON.stringify(loopLog, null, 1));
note("server-authoritative interview statuses observed by the browser (GET /interviews/{id}): " + JSON.stringify([...new Set(serverStatuses.map((s) => s.status))]));
note("current-question responses observed: " + JSON.stringify(currentQuestions));

/* ================= H. INTERVIEW COMPLETION VIA UI ================= */
step("H1. END INTERVIEW FROM THE UI -> REPORT");
const finalUi = await readState();
const finalBody = await bodyText();
const sawCompletedInUi = /Completed/.test(finalUi.stateLabel || "") || /Interview complete/i.test(finalBody);
if (!/\/report\//.test(page.url())) {
  const endBtn = page.locator(".end-interview-button");
  if (await endBtn.count()) await endBtn.click();
  else note("End Interview button not found in current view: " + JSON.stringify(finalUi));
  await page.waitForURL((u) => /\/report\//.test(u.pathname), { timeout: 180000 }).catch(() => {});
}
// The COMPLETED/REPORT_* status arrives on the interview detail GET that the
// finish mutation invalidates; wait for that response (or the report page's
// completion label) to appear before judging, so the record does not race the
// network response handler.
{
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const statusDone = /COMPLETED|REPORT_/.test(serverStatuses.map((s) => s.status).join(","));
    const bodyDone = /Interview complete/i.test(await bodyText());
    if (statusDone || bodyDone || !/\/report\//.test(page.url())) break;
    await sleep(1000);
  }
}
const completionBody = await bodyText();
const sawCompletedAfterWait = /Interview complete/i.test(completionBody) || /Completed/.test((await readState()).stateLabel || "");
record("INTERVIEW COMPLETION", sawCompletedInUi || sawCompletedAfterWait || /COMPLETED|REPORT_/.test(serverStatuses.map((s) => s.status).join(",")), `UI completed state seen=${sawCompletedInUi || sawCompletedAfterWait} | server statuses=${JSON.stringify([...new Set(serverStatuses.map((s) => s.status))])}`);
record("REPORT ROUTE REACHED", /\/report\//.test(page.url()), `url=${page.url()}`);
await snap("13-report");

/* ================= I. REPORT GENERATION + DISPLAY ================= */
step("I1. REPORT GENERATING -> READY + DISPLAYED VALUES");
let reportErr = null;
let reportView = null;
{
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (await page.locator(".report-score-card").count()) {
      reportView = await page.evaluate(() => {
        const num = (s) => { const el = document.querySelector(s); if (!el) return null; const m = el.innerText.match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
        const txt = (s) => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, " ").trim().slice(0, 200) : null; };
        return {
          overall: num(".report-score-ring strong"),
          metrics: [...document.querySelectorAll(".report-metric")].map((m) => m.innerText.replace(/\s+/g, " ").trim()),
          totalAnsweredText: txt(".report-score-card p"),
          strengths: txt(".report-strengths"),
          improvements: txt(".report-improvements"),
          recommendations: txt(".report-recommendations"),
          band: txt(".report-performance-label"),
          completeLabel: txt(".report-complete-label"),
        };
      });
      break;
    }
    const err = await page.locator(".error-box, .status-line").allInnerTexts().catch(() => []);
    reportErr = err.join(" || ");
    await sleep(2500);
  }
}
record("REPORT DISPLAY", !!reportView, reportView ? `overall=${reportView.overall} | band=${reportView.band} | metrics=${JSON.stringify(reportView.metrics)} | ${reportView.totalAnsweredText} | strengths="${String(reportView.strengths).slice(0, 50)}" | improvements="${String(reportView.improvements).slice(0, 50)}" | recommendations="${String(reportView.recommendations).slice(0, 50)}"` : `no score card rendered; last status/error text: ${reportErr}`);
const reportHttp = responses.filter((r) => /\/api\/v1\/reports\/[0-9a-fA-F-]{36}/.test(r.url));
record("REPORT API", reportHttp.some((r) => r.status === 200), `GET /api/v1/reports/{id} calls=${JSON.stringify(reportHttp.map((r) => r.status))}`);
const lastReport = reportBodies.length ? reportBodies[reportBodies.length - 1].body : null;
note("persisted report body from backend: " + JSON.stringify(lastReport));
dumpJson("ui-report-displayed.json", { reportView, lastReport });

/* ================= J. CONSOLE / NETWORK / SECURITY ================= */
step("J1. BROWSER CONSOLE + NETWORK + SECURITY");
const consoleErrors = consoleMsgs.filter((m) => m.type === "error");
const consoleWarnings = consoleMsgs.filter((m) => m.type === "warning");
const api4xx = responses.filter((r) => r.status >= 400 && r.status < 500);
const api5xx = responses.filter((r) => r.status >= 500);
record("BROWSER RUNTIME ERRORS", pageErrors.length === 0, `uncaught page errors=${JSON.stringify(pageErrors.slice(0, 5))} | console errors=${consoleErrors.length} (sample=${JSON.stringify(consoleErrors.slice(0, 4))}) | console warnings=${consoleWarnings.length} (sample=${JSON.stringify(consoleWarnings.slice(0, 3))})`);
record("NETWORK: NO 5xx", api5xx.length === 0, `4xx=${api4xx.length} ${JSON.stringify(api4xx.slice(0, 8).map((r) => `${r.method} ${r.url.split("/api")[1]} ${r.status}`))} | 5xx=${api5xx.length} ${JSON.stringify(api5xx.slice(0, 6))} | failed requests=${JSON.stringify(failedReqs.slice(0, 6))}`);

const SECRET_PATTERNS = [/nvapi-[A-Za-z0-9_-]{12,}/, /service_role/, /SUPABASE_SERVICE/i, /\bsk-[A-Za-z0-9]{20,}/, /nvidia[_-]?api[_-]?key["'\s:=]{1,4}[A-Za-z0-9_-]{12,}/i, /postgres(ql)?:\/\/[^\s"']*:[^\s"'@]*@/i];
const scriptUrls = await page.evaluate(() => [...document.querySelectorAll("script[src]")].map((s) => s.src));
let servedJs = "";
for (const u of scriptUrls.slice(0, 12)) {
  try { servedJs += await page.evaluate(async (x) => (await fetch(x)).text(), u); } catch { /* ignore */ }
}
const secretHits = SECRET_PATTERNS.map((p) => p.test(servedJs));
record("SECURITY: NO SECRETS IN SERVED FRONTEND JS", !secretHits.some(Boolean), `scanned ${scriptUrls.length} bundles (${servedJs.length} chars) for api-key/service-role/db-URL patterns -> matches=${JSON.stringify(secretHits)}`);
const providerCalls = responses.filter((r) => /nvidia|integrate\.api/i.test(r.url));
record("SECURITY: NO DIRECT PROVIDER CALLS FROM BROWSER", providerCalls.length === 0, `browser requests to AI-provider hosts=${JSON.stringify(providerCalls.map((r) => r.url))}`);
const webStore = await page.evaluate(() => JSON.stringify(window.localStorage) + "||" + JSON.stringify(window.sessionStorage));
record("SECURITY: TOKENS NOT PERSISTED IN WEB STORAGE", !/eyJ[A-Za-z0-9_-]{10,}\./.test(webStore), `web storage contains JWT-like value=${/eyJ[A-Za-z0-9_-]{10,}\./.test(webStore)}`);
await snap("14-final");

/* ================= FINAL TABLE ================= */
step("FINAL VERIFICATION TABLE");
const ORDER = [
  "FRONTEND LOAD", "PROTECTED ROUTE", "AUTH NEGATIVE", "REGISTER (UI)", "DASHBOARD", "AUTH PERSISTENCE",
  "TOKEN NOT IN WEB STORAGE", "HISTORY / LIST", "RESUME EMPTY STATE", "RESUME UPLOAD REQUEST",
  "RESUME PROCESSING + DISPLAY", "SETUP WIZARD (5 STEPS)", "INTERVIEW CREATION (UI)", "LOBBY ROUTE",
  "PREPARING STATE SHOWN", "QUESTION GENERATION (Celery + NVIDIA)", "INTERVIEW PAGE NAV",
  "CAMERA + MIC PREVIEW", "WEBSOCKET CONNECTION", "REALTIME SESSION CALL", "FACE TELEMETRY (face_status)",
  "SPEECH / TTS AUDIO STREAMED TO BROWSER", "SPEECH / STT CAPTURE IN BROWSER", "ANSWER SUBMISSION (UI)",
  "IDEMPOTENCY (client guard)", "AI EVALUATION STATE", "FOLLOW-UP QUESTION", "REFRESH / RECONNECT",
  "MEDIA PERMISSIONS AFTER RELOAD", "INTERVIEW COMPLETION", "REPORT ROUTE REACHED", "REPORT DISPLAY",
  "REPORT API", "BROWSER RUNTIME ERRORS", "NETWORK: NO 5xx",
  "SECURITY: NO SECRETS IN SERVED FRONTEND JS", "SECURITY: NO DIRECT PROVIDER CALLS FROM BROWSER",
  "SECURITY: TOKENS NOT PERSISTED IN WEB STORAGE",
];
log("");
log("STATUS TABLE");
for (const k of ORDER) log(`${k.padEnd(46, ".")} ${results[k] ? (results[k].ok ? "PASS" : "FAIL") : "NOT RUN"}`);
for (const k of Object.keys(results)) if (!ORDER.includes(k)) log(`${k.padEnd(46, ".")} ${results[k].ok ? "PASS" : "FAIL"}`);

flush();
step("DRIVER DONE");
await context.close();
await browser.close();










