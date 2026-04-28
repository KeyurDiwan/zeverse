#!/usr/bin/env node
/**
 * Verifies the same base URL the Slack bot uses (ARCHON_SERVER_URL) returns JSON from the API.
 * Run from repo root: npm run check:zeverse
 */
const path = require("path");
const http = require("http");
const https = require("https");

function loadEnv() {
  try {
    const dotenv = require("dotenv");
    const p = path.join(__dirname, "../.env");
    dotenv.config({ path: p, override: true });
  } catch {
    // optional
  }
}

loadEnv();
const base = (process.env.ARCHON_SERVER_URL || "http://127.0.0.1:3100").replace(/\/$/, "");

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: b, ct: res.headers["content-type"] || "" }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function check(pathname, needJson) {
  const url = base + pathname;
  process.stdout.write(`\n${pathname}\n  URL: ${url}\n  `);
  const { status, body, ct } = await get(url);
  const head = body.trimStart().slice(0, 80).replace(/\n/g, " ");
  process.stdout.write(`→ HTTP ${status} content-type: ${ct || "(none)"}\n  body: `);
  if (needJson) {
    if (body.trimStart().startsWith("<")) {
      console.log(head + "…");
      console.error(
        "\n  ERROR: got HTML, not JSON. The Slack bot will fail with 'Unexpected token'." +
          "\n  Fix: set ARCHON_SERVER_URL in .env to the API, e.g. http://127.0.0.1:3100" +
          "\n  (not the Vite UI on 5173). Unset a wrong shell var: env -u ARCHON_SERVER_URL npm run check:zeverse"
      );
      return false;
    }
    try {
      JSON.parse(body);
      console.log("valid JSON " + (body.length > 100 ? head + "…" : body));
    } catch (e) {
      console.log(head + "…");
      console.error("  ERROR: not valid JSON:", (e && e.message) || e);
      return false;
    }
  } else {
    console.log(head + (body.length > 80 ? "…" : ""));
  }
  return true;
}

(async () => {
  console.log(`ARCHON_SERVER_URL (effective) = ${base}`);
  if (/5173$/.test(base) && !/3100/.test(base)) {
    console.warn("Warning: URL ends with :5173 — use :3100 for the Express API.\n");
  }
  const a = await check("/health", true);
  const b = await check("/api/repos", true);
  if (a && b) process.exit(0);
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
