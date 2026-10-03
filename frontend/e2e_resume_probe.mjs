/**
 * TEMPORARY verification probe (not part of the app build).
 * Reproduces the resume upload -> "Ready" chip path in a real browser and
 * records every GET /api/v1/resumes response plus the rendered chip text, so a
 * client-side refresh/polling defect can be distinguished from a backend one.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const FE = process.env.FE_URL || "http://127.0.0.1:5173";
const OUT = process.env.OUT_DIR || ".";
const EMAIL = process.env.TEST_EMAIL;
const PASSWORD = process.env.TEST_PASSWORD;
const SRC_RESUME = process.env.RESUME_FILE;

const LOG = path.join(OUT, "resume-probe.log");
fs.writeFileSync(LOG, "");
const log = (...a) => {
  const l = a.map(String).join(" ");
  console.log(l);
  fs.appendFileSync(LOG, l + "\n");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: FE });
const page = await context.newPage();

page.on("request", (r) => {
  if (/\/api\/v1\/resumes/.test(r.url())) calls.push({ t: Date.now(), kind: "request", method: r.method(), url: r.url() });
});
page.on("response", async (r) => {
  if (!/\/api\/v1\/resumes/.test(r.url())) return;
  let items = null;
  try {
    const b = await r.json();
    items = b && b.items ? b.items.map((x) => `${x.filename}:${x.status}`) : b && b.status ? [`single:${b.status}`] : null;
  } catch { /* non-JSON */ }
  calls.push({ t: Date.now(), kind: "response", method: r.request().method(), status: r.status(), url: r.url(), items });
});

const T0 = Date.now();
const stamp = (t) => `+${((t - T0) / 1000).toFixed(1)}s`;
const nameOf = (item) => String(item).slice(0, String(item).lastIndexOf(":"));

log("PROBE: login -> /resume -> upload -> watch client refresh");
await page.goto(FE + "/login", { waitUntil: "networkidle" });
await page.fill("#login-email", EMAIL);
await page.fill("#login-password", PASSWORD);
await page.click("button.login-submit");
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }).catch(() => {});
log(`after login url=${page.url()}`);

await page.goto(FE + "/resume", { waitUntil: "networkidle" });
const chipTexts = () => page.evaluate(() => [...document.querySelectorAll(".resume-chip")].map((c) => c.innerText.trim()));
const statusTitle = () => page.evaluate(() => { const el = document.querySelector(".resume-status-card h2"); return el ? el.innerText.trim() : null; });
const rows = () => page.evaluate(() => [...document.querySelectorAll("tbody tr")].length);
log(`before upload: chips=${JSON.stringify(await chipTexts())} statusCardTitle=${JSON.stringify(await statusTitle())} tableRows=${await rows()}`);

const probeFile = path.join(OUT, `probe_resume_${Date.now()}.pdf`);
const targetName = path.basename(probeFile);
fs.copyFileSync(SRC_RESUME, probeFile);
const upIndex = calls.length;
await page.setInputFiles('input[type="file"]', probeFile);
await sleep(4000);
const uploadCalls = calls.slice(upIndex).filter((c) => c.kind === "response" && c.method === "POST");
log(`upload responses: ${JSON.stringify(uploadCalls.map((c) => ({ status: c.status, items: c.items })))}`);
log(`watching chip for the uploaded file: ${targetName}`);

let sawReadyForTarget = false;
for (let i = 0; i < 24; i++) {
  await sleep(3000);
  const getCalls = calls.filter((c) => c.kind === "response" && c.method === "GET");
  const lastItems = getCalls.length ? getCalls[getCalls.length - 1].items : null;
  const chips = await chipTexts();
  const idx = lastItems ? lastItems.map(nameOf).indexOf(targetName) : -1;
  log(`${stamp(Date.now())} GET count=${getCalls.length} targetStatus=${idx >= 0 && lastItems[idx] ? String(lastItems[idx]).split(":").pop() : "?"} targetChip=${JSON.stringify(idx >= 0 ? chips[idx] : null)} chips=${JSON.stringify(chips)} title=${JSON.stringify(await statusTitle())}`);
  if (idx >= 0 && chips[idx] === "Ready") { sawReadyForTarget = true; log("RESULT: PASS - uploaded resume reached the Ready chip without a manual reload"); break; }
}
if (!sawReadyForTarget) log("RESULT: FAIL - the uploaded resume never reached the Ready chip within the watch window");

log("\nFULL CALL TIMELINE");
for (const c of calls) log(`${stamp(c.t)} ${c.kind.padEnd(9)} ${c.method.padEnd(5)} ${c.status ?? ""} ${c.url.replace(FE, "")} ${c.items ? JSON.stringify(c.items) : ""}`);

await browser.close();
