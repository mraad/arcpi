// Records mappi's map page as a video: headless Chrome's DevTools screencast piped to ffmpeg.
//   node docs/video/record-map.ts <out.mp4> [page URL]   (default http://127.0.0.1:8787/; stop with SIGINT)
// Waits for the server's /health, then writes frames at a constant rate and <out.mp4>.json with
// the wall time of the first frame, so record.sh can line the map up with the terminal video.
// Opening the page also makes it mappi's target: run_map_code drives the newest page.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const [out, url = "http://127.0.0.1:8787/"] = process.argv.slice(2);
if (!out) {
  console.error("usage: node docs/video/record-map.ts <out.mp4> [page URL]");
  process.exit(2);
}
const chromeBin = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const fps = 10;
const [width, height] = [1280, 800];

while (!(await fetch(new URL("/health", url)).then((response) => response.ok, () => false))) await pause(500);

const profile = mkdtempSync(join(tmpdir(), "record-map-"));
const chrome = spawn(chromeBin, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  `--window-size=${width},${height}`, "--hide-scrollbars", "--mute-audio", "--no-first-run", url], { stdio: "ignore" });
const portFile = join(profile, "DevToolsActivePort");
let port = "";
for (const deadline = Date.now() + 30_000; !port; await pause(100)) {
  if (chrome.exitCode !== null || Date.now() > deadline) {
    chrome.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`Chrome did not start (${chromeBin}); set CHROME_BIN.`);
  }
  if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0];
}
const targets: { type: string; webSocketDebuggerUrl: string }[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
await once(socket, "open");

let ids = 0;
const replies = new Map<number, () => void>();
const send = (method: string, params: object = {}) => new Promise<void>((resolve) => {
  replies.set(++ids, resolve);
  socket.send(JSON.stringify({ id: ids, method, params }));
});
let latest: Buffer | undefined;
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(String(data));
  if (message.id) {
    replies.get(message.id)?.();
    replies.delete(message.id);
  } else if (message.method === "Page.screencastFrame") {
    latest = Buffer.from(message.params.data, "base64");
    void send("Page.screencastFrameAck", { sessionId: message.params.sessionId });
  }
});

const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg",
  "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { stdio: ["pipe", "inherit", "inherit"] });
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
// Chrome opened the page itself: a navigation after startScreencast can swap the renderer and lose it.
await send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height });

// Chrome sends frames only when the page changes: repeat the latest one to keep wall-clock time.
let started: number | undefined;
let written = 0;
const tick = setInterval(() => {
  if (!latest) return;
  if (started === undefined) {
    started = Date.now();
    writeFileSync(`${out}.json`, JSON.stringify({ started: started / 1000, fps }));
  }
  for (const due = Math.floor((Date.now() - started) * fps / 1000) + 1; written < due; written++) ffmpeg.stdin.write(latest);
}, 1000 / fps);

// SIGINT from record.sh ends a recording; SIGTERM comes from its exit trap after a failure.
const stop = async () => {
  clearInterval(tick);
  socket.close();
  chrome.kill();
  ffmpeg.stdin.end();
  await Promise.all([once(ffmpeg, "exit"), once(chrome, "exit")]);
  rmSync(profile, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
