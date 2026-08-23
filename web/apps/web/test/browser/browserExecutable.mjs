import { existsSync } from "node:fs";
import process from "node:process";
import { chromium } from "playwright-core";

function configuredPlaywrightChromium() {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

const candidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  configuredPlaywrightChromium(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export function browserExecutable() {
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable) return executable;
  throw new Error(
    "Chrome or Chromium was not found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to its executable path.",
  );
}
