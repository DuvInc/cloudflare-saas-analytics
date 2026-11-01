#!/usr/bin/env node
/*
  Regenerates docs/*.png and .github/social-preview.png from the real dashboard running on invented
  data (web/dev-mock.ts). Never edit the images by hand: change the mock, run this.

    npm run screenshots          needs Google Chrome (or CHROME_PATH); the dashboard code is built from this repo
*/
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!CHROME) { console.error("Chrome not found: set CHROME_PATH."); process.exit(1); }
const PORT = 5199;
const BASE = `http://localhost:${PORT}/`;

const shots = [
  { out: "docs/overview.png", route: "", w: 1440, h: 1060 },
  { out: "docs/product.png", route: "#/p/acme", w: 1440, h: 1150 },
  { out: "docs/funnels.png", route: "#/funnels", w: 1440, h: 900 },
  { out: "docs/ai-bots.png", route: "#/ai", w: 1440, h: 1000 },
  { out: "docs/replays.png", route: "#/replays", w: 1440, h: 900 },
];

const server = spawn("npx", ["vite", "--config", "web/vite.config.ts", "--port", String(PORT)], { cwd: ROOT, env: { ...process.env, MOCK: "1" }, stdio: "ignore" });
const shoot = (url, out, w, h, scale) => execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`, "--allow-file-access-from-files", "--virtual-time-budget=25000", `--screenshot=${path.join(ROOT, out)}`, url], { stdio: "ignore" });

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  for (const s of shots) { shoot(BASE + s.route, s.out, s.w, s.h, 2); console.log(`wrote ${s.out}`); }
  shoot(`file://${path.join(ROOT, "scripts/social-preview.html")}`, ".github/social-preview.png", 1280, 640, 1);
  console.log("wrote .github/social-preview.png");
} finally { server.kill(); }
