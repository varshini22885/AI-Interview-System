/**
 * TEMPORARY verification probe (not part of the app build).
 * Answers one question: does the interview page re-acquire camera/microphone
 * after a browser refresh, and how long does it take? The in-journey driver
 * asserted immediately after the reload, so this probe polls instead of
 * sampling once, to separate a real regression from a test race.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const FE = process.env.FE_URL || "http://127.0.0.1:5173";
const OUT = process.env.OUT_DIR || ".";
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const INTERVIEW_ID = process.env.INTERVIEW_ID;

const LOG = path.join(OUT, "media-probe.log");
fs.writeFileSync(LOG, "");
const log = (...a) => {
  const l = a.map(String).join(" ");
  console.log(l);
  fs.appendFileSync(LOG, l + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: FE, permissions: ["camera", "microphone"] });
const page = await context.newPage();

const mediaState = () =>
  page.evaluate(() => {
    const video = document.querySelector(".candidate-video-card video");
    let tracks = [];
    try {
      const s = video && video.srcObject;
      if (s) tracks = s.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.enabled}`);
    } catch { tracks = []; }
    return {
      cameraCardText: document.querySelector(".candidate-video-card .video-card-top")?.innerText.trim() ?? null,
      micText: document.querySelector(".candidate-name span")?.innerText.trim() ?? null,
      videoExists: !!video,
      videoReadyState: video ? video.readyState : null,
      videoWidth: video ? video.videoWidth : null,
      tracks,
    };
  });

/** Direct getUserMedia from the page: separates an env-less device from an app defect. */
const control = () =>
  page.evaluate(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "no getUserMedia API" };
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const info = s.getTracks().map((t) => `${t.kind}:${t.readyState}`);
      s.getTracks().forEach((t) => t.stop());
      return { ok: true, tracks: info };
    } catch (e) {
      return { ok: false, reason: `${e.name}: ${e.message}` };
    }
  });

log("PROBE: interview page media acquisition across a browser refresh");
await page.goto(FE + "/login", { waitUntil: "networkidle" });
const envBefore = await control();
log(`ENV control before the app flow: ${JSON.stringify(envBefore)}`);
if (!envBefore.ok) {
  log("RESULT: ENV BROKEN - this browser instance has no usable camera/mic device, so the app cannot be judged (retry in a clean browser process).");
  await browser.close();
  process.exit(0);
}
await page.fill("#login-email", EMAIL);
await page.fill("#login-password", PASSWORD);
await page.click("button.login-submit");
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }).catch(() => {});
log(`after login url=${page.url()}`);

await page.goto(`${FE}/interview/${INTERVIEW_ID}`, { waitUntil: "networkidle" });
let firstLoadReady = null;
for (let i = 0; i < 15; i++) {
  const st = await mediaState();
  log(`first load +${i}s ${JSON.stringify(st)}`);
  if (st.tracks.length >= 2 && st.videoReadyState >= 2) { firstLoadReady = st; break; }
  await sleep(1000);
}
log(`first load: media ready=${!!firstLoadReady}`);

log("\n--- refresh ---");
await page.reload({ waitUntil: "networkidle" });
let readyAfterReload = null;
for (let i = 0; i < 25; i++) {
  const st = await mediaState();
  log(`after reload +${i}s ${JSON.stringify(st)}`);
  if (st.tracks.length >= 2 && st.videoReadyState >= 2) { readyAfterReload = st; break; }
  await sleep(1000);
}
const envAfter = await control();
log(`ENV control after the refresh: ${JSON.stringify(envAfter)}`);

if (readyAfterReload) {
  log(`RESULT: PASS - camera/mic re-attached to the preview after refresh (${JSON.stringify(readyAfterReload.tracks)})`);
} else if (!envAfter.ok) {
  log("RESULT: INCONCLUSIVE (ENV) - the fake device disappeared after the reload, so this browser instance cannot judge the app. Retry in a clean browser process.");
} else {
  log("RESULT: FAIL (APP) - the device is usable (control call succeeded) but the page never attached a live stream to the preview after refresh.");
}
await browser.close();
