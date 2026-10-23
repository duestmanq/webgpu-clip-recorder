// Record one WebGPU game on macOS (Metal) with Playwright recordVideo.
// Usage: node scripts/record.mjs --url <url> --slug <slug> [--title t] [--duration 30] [--warmup 15] [--out out]
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  url: { type: 'string' }, slug: { type: 'string' }, title: { type: 'string', default: '' },
  duration: { type: 'string', default: '30' }, warmup: { type: 'string', default: '10' }, settle: { type: 'string', default: '10' },
  out: { type: 'string', default: 'out' }, width: { type: 'string', default: '1280' }, height: { type: 'string', default: '720' },
  headless: { type: 'boolean', default: false },
} });
if (!o.url || !o.slug) throw new Error('--url and --slug required');
const DUR = Number(o.duration), WARM = Number(o.warmup), SETTLE = Number(o.settle), W = Number(o.width), H = Number(o.height);
const OUT = path.resolve(o.out); fs.mkdirSync(OUT, { recursive: true });
const ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--use-angle=metal',
  // keep Chrome off the local network (macOS "find devices on local networks" prompt) and quiet
  '--disable-features=MediaRouter,DialMediaRouteProvider,GlobalMediaControls,OptimizationHints',
  '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--autoplay-policy=no-user-gesture-required'];
const report = { slug: o.slug, title: o.title, url: o.url, platform: `${process.platform}-${process.arch}`, args: ARGS,
  headless: o.headless, durationSec: DUR, warmupSec: WARM, settleSec: SETTLE, startedAt: new Date().toISOString(), console: [], pageErrors: [] };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, v = null) => Promise.race([p, sleep(ms).then(() => v)]);
const save = () => fs.writeFileSync(path.join(OUT, `${o.slug}.json`), JSON.stringify(report, null, 2));

const COUNTERS = `(() => { if (window.__ctr) return;
  const c = window.__ctr = { raf: 0, submits: 0, t0: performance.now(), id: Math.random() };
  const tick = () => { c.raf++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  try { const P = window.GPUQueue && GPUQueue.prototype; if (P) { const s = P.submit; P.submit = function (...a) { c.submits++; return s.apply(this, a); }; } } catch (e) {}
  try { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { (c.ctx ||= []).includes(t) || c.ctx.push(t); return g.call(this, t, ...a); }; } catch (e) {}
})();`;
const PROBE = async () => {
  const r = { secureContext: isSecureContext, hasGpu: !!navigator.gpu };
  try { const cv = document.createElement('canvas'), gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (gl) { const e = gl.getExtension('WEBGL_debug_renderer_info'); r.webglRenderer = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } } catch (e) {}
  try { const a = navigator.gpu && await navigator.gpu.requestAdapter();
    if (!a) r.error = 'no adapter'; else { const i = a.info || await a.requestAdapterInfo?.() || {};
      r.adapter = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: i.isFallbackAdapter ?? a.isFallbackAdapter };
      r.featureCount = a.features.size; r.maxTextureDimension2D = a.limits.maxTextureDimension2D; r.maxBufferSize = a.limits.maxBufferSize; }
  } catch (e) { r.error = String(e.message || e); }
  return r;
};

// Find a visible Start/Play control with one DOM pass (fast even when the page is busy), then click it.
async function clickStart(page) {
  const hit = await withTimeout(page.evaluate(() => {
    const KEY = String.raw`(\s*(enter|space|↵|⏎|return))?`;
    const exact = new RegExp(String.raw`^\s*[▶►>]?\s*(start|play|play now|play game|start game|start playing|click to play|tap to play|click to start|tap to start|press start|begin|launch)\s*[!▶►>]*` + KEY + String.raw`\s*$`, 'i');
    const vis = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 ? r : null; };
    const els = [...document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], .btn, .button')];
    for (const el of els) {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const r = t && exact.test(t) && vis(el);
      if (r) return { how: 'button:' + t.slice(0, 40), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const txt = document.body ? document.body.innerText : '';
    if (/(click|tap)( anywhere)? to (play|start|begin)|press any key|click anywhere/i.test(txt)) return { how: 'center-click', x: innerWidth / 2, y: innerHeight / 2 };
    return null;
  }), 15000, 'timeout');
  if (!hit) return [];
  if (hit === 'timeout') return ['evaluate-timeout'];
  await withTimeout(page.mouse.click(hit.x, hit.y), 5000);
  if (hit.how === 'center-click') await withTimeout(page.keyboard.press('Enter'), 3000);
  return [hit.how];
}

// Video analysis: per-sample luma mean/std and motion between samples.
function analyse(mp4) {
  const sw = 64, sh = 36;
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-i', mp4, '-vf', `fps=2,scale=${sw}:${sh},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const buf = r.stdout, n = Math.floor(buf.length / (sw * sh));
  const frames = []; let motion = 0, prev = null;
  for (let f = 0; f < n; f++) {
    const px = buf.subarray(f * sw * sh, (f + 1) * sw * sh);
    let s = 0, s2 = 0; for (const v of px) { s += v; s2 += v * v; }
    const mean = s / px.length, std = Math.sqrt(Math.max(0, s2 / px.length - mean * mean));
    if (prev) { let d = 0; for (let i = 0; i < px.length; i++) d += Math.abs(px[i] - prev[i]); motion += d / px.length; }
    prev = px; frames.push({ mean, std });
  }
  const avg = k => frames.reduce((a, b) => a + b[k], 0) / Math.max(1, frames.length);
  const meanLuma = avg('mean'), meanStd = avg('std'), avgMotion = n > 1 ? motion / (n - 1) : 0;
  let verdict = 'rendered';
  if (meanStd < 6) verdict = meanLuma > 200 ? 'blank-white' : meanLuma < 30 ? 'blank-black' : 'blank-flat';
  else if (avgMotion < 0.3) verdict = 'static';
  // changed frames (mpdecimate) = frames that actually differ
  const d = spawnSync(ffmpegPath, ['-i', mp4, '-vf', 'mpdecimate', '-fps_mode', 'vfr', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...(d.stderr || '').matchAll(/frame=\s*(\d+)/g)].pop();
  return { samples: n, meanLuma: +meanLuma.toFixed(1), meanStd: +meanStd.toFixed(1), avgMotion: +avgMotion.toFixed(2), changedFrames: m ? Number(m[1]) : null, verdict };
}
function probeVideo(file) {
  const r = spawnSync(ffprobe.path, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout || '{}'), s = j.streams?.[0] || {};
  return { codec: s.codec_name, width: s.width, height: s.height, fps: s.avg_frame_rate, frames: Number(s.nb_read_frames), duration: Number(j.format?.duration), bytes: Number(j.format?.size) };
}

let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', headless: o.headless, args: ARGS, timeout: 60000 });
  report.browserVersion = browser.version();
  const vdir = path.join(OUT, 'raw-' + o.slug);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: { width: W, height: H } } });
  await ctx.addInitScript(COUNTERS);
  const page = await ctx.newPage();
  const t0 = Date.now();
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && report.console.length < 60) report.console.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => { if (report.pageErrors.length < 30) report.pageErrors.push(e.message.slice(0, 300)); });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(o.url, { waitUntil: 'load', timeout: 90000 }).catch(e => { report.gotoError = e.message.split('\n')[0]; });
  report.gpu = await withTimeout(page.evaluate(PROBE), 15000, { error: 'probe timeout' });
  log('gpu', JSON.stringify(report.gpu));
  await sleep(WARM * 1000);
  report.startClicks = await clickStart(page);
  log('start clicks', report.startClicks);
  await withTimeout(page.screenshot({ path: path.join(OUT, `${o.slug}-after-click.png`), timeout: 10000 }).catch(() => {}), 12000);
  await sleep(SETTLE * 1000);
  // a second pass catches two-step menus (e.g. "Play" then "Start")
  if (report.startClicks.length) { const more = await clickStart(page); if (more.length) { report.startClicks.push(...more); await sleep(Math.min(SETTLE, 5) * 1000); } }
  const recStart = (Date.now() - t0) / 1000;
  const c0 = await withTimeout(page.evaluate(() => ({ ...window.__ctr, now: performance.now() })), 10000);
  const tEnd = Date.now() + DUR * 1000; let i = 0;
  while (Date.now() < tEnd) { await withTimeout(page.mouse.move(W / 2 + Math.sin(i) * 200, H / 2 + Math.cos(i) * 120), 2000); i++; await sleep(1000); }
  const c1 = await withTimeout(page.evaluate(() => ({ ...window.__ctr, now: performance.now() })), 10000);
  await withTimeout(page.screenshot({ path: path.join(OUT, `${o.slug}-end.png`), timeout: 10000 }).catch(() => {}), 12000);
  if (c1) {
    const base = c0 && c0.id === c1.id ? c0 : { raf: 0, submits: 0, now: c1.t0 }; // page reloaded mid-recording
    const dt = (c1.now - base.now) / 1000;
    report.inPage = { seconds: +dt.toFixed(2), rafFps: +((c1.raf - base.raf) / dt).toFixed(1), gpuSubmitsPerSec: +((c1.submits - base.submits) / dt).toFixed(1), contexts: c1.ctx || [], reloaded: !(c0 && c0.id === c1.id) };
  } else report.inPage = { error: 'page unresponsive (evaluate timed out)' };
  log('inPage', JSON.stringify(report.inPage));
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const mp4 = path.join(OUT, `${o.slug}.mp4`);
  // trim to the recording window, real-time 30 fps H.264 1280x720 (catalog format)
  const ff = spawnSync(ffmpegPath, ['-y', '-v', 'error', '-ss', recStart.toFixed(2), '-i', webm, '-t', String(DUR),
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-profile:v', 'high', '-movflags', '+faststart', '-an', mp4], { encoding: 'utf8' });
  if (ff.status !== 0) throw new Error('ffmpeg failed: ' + ff.stderr);
  spawnSync(ffmpegPath, ['-y', '-v', 'error', '-ss', String(Math.floor(DUR / 2)), '-i', mp4, '-frames:v', '1', '-q:v', '3', path.join(OUT, `${o.slug}.jpg`)]);
  report.video = { ...probeVideo(mp4), trimmedFromSec: +recStart.toFixed(2) };
  report.check = analyse(mp4);
  report.video.changedFps = report.check.changedFrames ? +(report.check.changedFrames / report.video.duration).toFixed(1) : null;
  fs.rmSync(vdir, { recursive: true, force: true });
  report.ok = report.check.verdict === 'rendered' && !!report.gpu?.adapter;
} catch (e) { report.ok = false; report.error = e.message; process.exitCode = 1; }
finally {
  if (browser) await withTimeout(browser.close(), 15000);
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ ...report, console: report.console.slice(0, 10) }, null, 2));
}
