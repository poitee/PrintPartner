import assert from "node:assert/strict";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { log } from "node:console";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { BoxGeometry, Mesh, MeshBasicMaterial } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { browserExecutable } from "./browserExecutable.mjs";

const api = process.env.FILENAME_GROUP_API ?? "http://127.0.0.1:18765";
const ui = process.env.FILENAME_GROUP_UI ?? "http://127.0.0.1:5173";
async function request(path, method = "GET", value) {
  const response = await globalThis.fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const body = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
  return body;
}
assert.ok((await request("/health")).data_dir.startsWith("/tmp/pp-filename-groups-"), "Use an isolated fixture server");
const source = await request("/sources", "POST", { name: `Filename grouping fixture ${randomUUID()}`, source_kind: "local" });
const geometry = new BoxGeometry(5, 6, 7);
const material = new MeshBasicMaterial();
const bytes = strToU8(new STLExporter().parse(new Mesh(geometry, material)));
geometry.dispose(); material.dispose();
const files = { "[a]-mount-S.stl": bytes, "[a]-cover-A.stl": bytes, "base-S.stl": bytes, "unknown.stl": bytes };
const form = new globalThis.FormData();
form.append("file", new globalThis.Blob([zipSync(files)]), "parts.zip");
const upload = await globalThis.fetch(`${api}/sources/${source.id}/upload-zip`, { method: "POST", body: form });
assert.ok(upload.ok, await upload.text());
const build = await request("/plans", "POST", { name: `Filename grouping test ${randomUUID()}` });
await request(`/plans/${build.id}/layers/base`, "PUT", { project_id: source.id });
const { draft } = await request(`/plans/${build.id}/drafts/recompute`, "POST", { apply_manifest: true });
await request(`/plans/${build.id}/drafts/${draft.draft_id}/apply`, "POST", { expected_snapshot_digest: draft.snapshot_digest, expected_lifecycle_version: draft.lifecycle_version, expected_base: draft.base });

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${ui}/export?profile=${build.id}`);
  await page.getByRole("radio", { name: /Download sorted STL files/ }).click({ timeout: 60000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Download.*STL|Choose and download/i }).first().click();
  const checkbox = page.getByRole("checkbox", { name: "Group by filename rules, such as print settings" });
  await checkbox.check();
  const editor = page.getByRole("region", { name: "Custom filename grouping" });
  await editor.getByLabel("Grouping name").fill("Print settings test");
  await editor.getByRole("button", { name: "Save groups", exact: true }).click();
  await editor.getByText("Filename groups saved for this Build.", { exact: true }).waitFor();
  assert.equal((await request(`/plans/${build.id}/filename-grouping`)).definition.name, "Print settings test");
  await checkbox.uncheck(); await checkbox.check();
  await editor.getByLabel("Grouping name").waitFor();
  assert.equal(await editor.getByLabel("Grouping name").inputValue(), "Print settings test");
  await editor.getByLabel("Color role", { exact: true }).selectOption("accent");
  await editor.getByLabel("Export group", { exact: true }).selectOption("Structural");
  await page.getByRole("button", { name: "Download sorted STL files", exact: true }).click();
  await page.getByRole("link", { name: "Save the files", exact: true }).waitFor({ timeout: 60000 });
  const downloadHref = await page.getByRole("link", { name: "Save the files", exact: true }).getAttribute("href");
  const downloadUrl = new globalThis.URL(downloadHref, ui);
  assert.equal(downloadUrl.origin, new globalThis.URL(ui).origin);
  const downloadResponse = await page.request.get(downloadUrl.href);
  assert.equal(downloadResponse.status(), 200);
  assert.equal(downloadResponse.headers()["content-type"], "application/zip");
  assert.equal(downloadResponse.headers()["x-content-type-options"], "nosniff");
  assert.match(downloadResponse.headers()["content-disposition"], /^attachment;/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save the files", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const zip = unzipSync(await readFile(await download.path()));
  assert.equal(Object.keys(zip).length, 1);
  assert.match(Object.keys(zip)[0], /^accent\/Structural\/.*mount-S.*\.stl$/);
  assert.deepEqual(zip[Object.keys(zip)[0]], bytes);
  await editor.getByLabel("Export group", { exact: true }).selectOption("");
  await editor.getByLabel("Filename suffix 1", { exact: true }).fill("S");
  await editor.getByText(/Some filenames match different groups/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Download sorted STL files", exact: true }).isDisabled(), true);
  await editor.getByRole("button", { name: "Use Milo rules" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/pp-filename-grouping-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
  assert.deepEqual(errors, []);
  const recoveryPage = await browser.newPage();
  /** @type {{ exportJobs: string[], closedSocketJobs: string[], deniedPollJobs: string[], failedPollJobs: string[], recoveredPollJobs: string[], fixtureErrors: string[] }} */
  const observation = { exportJobs: [], closedSocketJobs: [], deniedPollJobs: [], failedPollJobs: [], recoveredPollJobs: [], fixtureErrors: [] };
  /** @type {Map<string, ReturnType<typeof Promise.withResolvers>>} */
  const socketClosures = new Map();
  const socketClosureFor = (jobId) => {
    if (!socketClosures.has(jobId)) socketClosures.set(jobId, Promise.withResolvers());
    return socketClosures.get(jobId);
  };
  const awaitWitness = async (promise, receipt) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_resolve, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error(`Timed out waiting for ${receipt}`)), 5000);
      })]);
    } finally { globalThis.clearTimeout(timer); }
  };
  const jobStatus = /\/jobs\/[^/?]+$/;
  const jobIdFromUrl = (url) => {
    const match = new globalThis.URL(url).pathname.match(/\/jobs\/([^/]+)$/);
    assert.ok(match, "Expected a fixture job endpoint");
    return decodeURIComponent(match[1]);
  };
  await recoveryPage.routeWebSocket(/\/ws\/jobs\/[^/?]+$/, async (socket) => {
    const jobId = jobIdFromUrl(socket.url());
    try {
      await awaitWitness(socket.close(), `socket close for job ${jobId}`);
      observation.closedSocketJobs.push(jobId);
      socketClosureFor(jobId).resolve(jobId);
    } catch (error) {
      observation.fixtureErrors.push(`Socket ${jobId}: ${error.message}`);
    }
  });
  await recoveryPage.route(jobStatus, async (route) => {
    const request = route.request();
    const jobId = jobIdFromUrl(request.url());
    try {
      if (request.method() === "POST" && jobId === "export-stl-pack") {
        assert.equal(request.postDataJSON().profile_id, build.id, "The export must belong to the fixture Build");
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
        assert.ok(response.ok(), "The real export start must succeed");
        const started = await response.json();
        assert.equal(typeof started.job_id, "string");
        assert.ok(started.job_id.length > 0, "The real export start must return a job ID");
        assert.ok(!observation.exportJobs.includes(started.job_id), "Each export must start a new job");
        observation.exportJobs.push(started.job_id);
        await route.fulfill({ response });
        return;
      }
      if (request.method() !== "GET" || jobId !== observation.exportJobs[0]) return await route.continue();
      const closedJobId = await awaitWitness(socketClosureFor(jobId).promise, `closed socket for failed poll job ${jobId}`);
      assert.equal(jobId, closedJobId, "The failed poll must observe its own interrupted socket");
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Test connection interrupted" }) });
      observation.deniedPollJobs.push(jobId);
    } catch (error) {
      observation.fixtureErrors.push(`Request ${request.method()} ${jobId}: ${error.message}`);
      try { await route.abort("failed"); }
      catch (abortError) { observation.fixtureErrors.push(`Abort ${jobId}: ${abortError.message}`); }
    }
  });
  recoveryPage.on("response", (response) => {
    if (response.request().method() !== "GET" || !jobStatus.test(response.url())) return;
    const jobId = jobIdFromUrl(response.url());
    if (response.status() === 503) observation.failedPollJobs.push(jobId);
    if (response.status() === 200) observation.recoveredPollJobs.push(jobId);
  });
  const recoveryError = recoveryPage.getByText("Could not download the STL files", { exact: true });
  const lostContact = recoveryPage.getByText(/Lost contact with the job/).first();
  const recoveredDownload = recoveryPage.getByRole("link", { name: "Save the files", exact: true });
  try {
    await recoveryPage.goto(`${ui}/export?profile=${build.id}`);
    await recoveryPage.getByRole("button", { name: /Download.*STL|Choose and download/i }).first().click();
    await recoveryPage.getByRole("button", { name: "Download sorted STL files", exact: true }).click();
    await recoveryError.waitFor();
    await lostContact.waitFor();
    assert.deepEqual(observation.fixtureErrors, [], "Fault handlers must finish without errors");
    assert.equal(observation.exportJobs.length, 1, "The interrupted export must have one real start receipt");
    const interruptedJobId = observation.exportJobs[0];
    assert.ok(observation.closedSocketJobs.includes(interruptedJobId), "The intended export's canonical job socket must be closed");
    assert.ok(observation.deniedPollJobs.length > 0, "The job HTTP status request must receive the injected 503");
    assert.ok(observation.deniedPollJobs.every((id) => id === interruptedJobId && observation.closedSocketJobs.includes(id)));
    assert.ok(observation.failedPollJobs.includes(interruptedJobId), "The browser must receive the intended export's HTTP 503");
    const recoveryButton = recoveryPage.getByRole("button", { name: "Download sorted STL files", exact: true });
    assert.equal(await recoveryButton.isEnabled(), true);
    assert.equal(await recoveryButton.getAttribute("aria-busy"), null, "The failed export spinner must stop");
    await recoveryPage.getByRole("button", { name: "Try again", exact: true }).click();
    await recoveredDownload.waitFor();
    assert.equal(observation.exportJobs.length, 2, "Try again must start a real new export");
    const retryJobId = observation.exportJobs[1];
    assert.notEqual(retryJobId, interruptedJobId, "Retry must observe a new job");
    await awaitWitness(socketClosureFor(retryJobId).promise, `closed socket for retry job ${retryJobId}`);
    assert.ok(observation.recoveredPollJobs.includes(retryJobId), "Retry must receive a real successful HTTP job status");
    assert.ok(!observation.deniedPollJobs.includes(retryJobId), "Retry polling must reach the real server");
    const retryDownloadPromise = recoveryPage.waitForEvent("download");
    await recoveredDownload.click();
    const retryDownload = await retryDownloadPromise;
    assert.equal(await retryDownload.failure(), null);
    const retryZip = unzipSync(await readFile(await retryDownload.path()));
    assert.equal(Object.keys(retryZip).length, Object.keys(files).length);
    for (const contents of Object.values(retryZip)) assert.deepEqual(contents, bytes);
    await recoveryPage.unrouteAll({ behavior: "wait" });
    assert.deepEqual(observation.fixtureErrors, [], "Fault handlers must finish without errors");
    log("PASS: job observation fault witnesses", { build: build.id, retryDownloadedFiles: Object.keys(retryZip), ...observation });
  } catch (error) {
    log("FAIL: job observation fault witnesses", {
      build: build.id,
      ...observation,
      closedSockets: observation.closedSocketJobs.length,
      deniedPolls: observation.deniedPollJobs.length,
      successfulRetryPolls: observation.recoveredPollJobs.length,
      errorVisible: await recoveryError.isVisible(),
      lostContactVisible: await lostContact.isVisible(),
      downloadVisible: await recoveredDownload.isVisible(),
    });
    throw error;
  }
  await recoveryPage.close();
  log("PASS: interrupted job observation stops the spinner; retry completes through HTTP polling without WebSocket");
  log("PASS: real upload, saved rules reload, Accent + Structural ZIP download with identical STL bytes, overlap warning, mobile layout", { build: build.id });
} finally { await browser.close(); }
