// Render kiwiboard-promo.html to numbered JPEG frames with headless Chrome.
//
//   node render.mjs frames <outDir> [fps=30] [workers=5]      every frame of the video
//   node render.mjs snap <outDir> <t1,t2,...>                 single frames (PNG) for review
//
// Each worker is its own Chrome; frames are a pure function of time, so the
// workers just split the frame range. Then: swift encode.swift <outDir> out.mp4 <fps>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(path.join(HERE, "kiwiboard-promo.html")).href + "?render=1";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openChrome(port, profile) {
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--mute-audio", "--force-color-profile=srgb", "--allow-file-access-from-files",
    "--run-all-compositor-stages-before-draw", "--disable-checker-imaging", "--disable-gpu-rasterization",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore"] });
  let ws = null;
  for (let i = 0; i < 120 && !ws; i++) {
    await sleep(150);
    try { ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  }
  if (!ws) throw new Error("Chrome did not start on port " + port);
  const sock = new WebSocket(ws);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  let id = 0; const pending = new Map();
  sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const k = ++id; pending.set(k, { res, rej }); sock.send(JSON.stringify({ id: k, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable"); await s("Runtime.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expr) => {
    const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await s("Page.navigate", { url: PAGE });
  for (let i = 0; i < 300; i++) { await sleep(100); try { if (await evaluate("window.__ready === true")) break; } catch {} }
  if (!(await evaluate("window.__ready === true"))) throw new Error("page never became ready");
  return {
    async frame(t, format = "jpeg") {
      await evaluate(`window.__render(${t})`);
      const shot = await s("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 94 } : {}), clip: { x: 0, y: 0, width: 1440, height: 1080, scale: 1 } });
      return Buffer.from(shot.data, "base64");
    },
    duration: () => evaluate("window.__duration"),
    close() { try { sock.close(); } catch {} proc.kill("SIGKILL"); },
  };
}

const [mode, outDir, arg3, arg4] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, ".chrome");

if (mode === "snap") {
  const times = arg3.split(",").map(Number);
  const c = await openChrome(9450, path.join(tmp, "snap"));
  for (const t of times) writeFileSync(path.join(outDir, `t${t.toFixed(2).padStart(6, "0")}.png`), await c.frame(t, "png"));
  c.close();
  console.log("snapped", times.length);
} else {
  const fps = +(arg3 || 30), workers = +(arg4 || 5);
  const probe = await openChrome(9460, path.join(tmp, "probe"));
  const dur = await probe.duration(); probe.close();
  const total = Math.round(dur * fps);
  const t0 = Date.now();
  let done = 0;
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const c = await openChrome(9470 + w, path.join(tmp, "w" + w));
    for (let f = w; f < total; f += workers) {
      writeFileSync(path.join(outDir, `f${String(f).padStart(5, "0")}.jpg`), await c.frame(f / fps));
      if (++done % 150 === 0) console.log(`${done}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    c.close();
  }));
  console.log(`done: ${total} frames at ${fps} fps in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
await sleep(800);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(0);
