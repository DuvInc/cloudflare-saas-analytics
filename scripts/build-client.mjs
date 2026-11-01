/* The dashboard is built by Vite (web/). Builds the browser code into public/: tracker (t.js), replay (replay.js), replay player (player.js + .css). */
import { build } from "esbuild";
const common = { bundle: true, minify: true, legalComments: "none", format: "iife" };
await build({ ...common, target: "es2019", entryPoints: ["client/tracker.ts"], outfile: "public/t.js" });
await build({ ...common, target: "es2020", entryPoints: ["client/replay.ts"], outfile: "public/replay.js" });
await build({ ...common, target: "es2022", entryPoints: ["client/player.ts"], outfile: "public/player.js", loader: { ".css": "css" } });
