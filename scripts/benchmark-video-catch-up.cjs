#!/usr/bin/env node
// Local research only: no application, BBB server, or source media is modified.
// Requires Playwright separately; it is deliberately not an app dependency.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --option value pairs');
    options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (!options.video || !options.browser || !options.output) {
    throw new Error('Usage: node scripts/benchmark-video-catch-up.cjs --video FILE.webm --browser CHROMIUM --output results.json [--playwright MODULE_PATH] [--mode sweep|recovery] [--policies current,fast8,fast12,fast16] [--seconds 4] [--lag 60] [--audio-rate 1]');
  }
  const videoFile = path.resolve(options.video);
  const size = fs.statSync(videoFile).size;
  const mode = options.mode || 'sweep';
  assert(['sweep', 'recovery'].includes(mode));
  for (const [name, fallback] of [['seconds', 4], ['lag', 60], ['audio-rate', 1]]) {
    assert(Number.isFinite(Number(options[name] || fallback)) && Number(options[name] || fallback) > 0, 'Invalid ' + name);
  }
  const { chromium } = require(options.playwright || 'playwright');
  const controllerSource = fs.readFileSync(path.resolve(__dirname, '../src/components/recording-editor/videoSync.js'), 'utf8');
  const { synchronizationRate } = await import('data:text/javascript;base64,' + Buffer.from(controllerSource).toString('base64'));
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Video catch-up benchmark</title><video muted playsinline style="width:640px;height:360px"></video>');
    } else if (req.url === '/fixture.webm') {
      res.setHeader('Content-Type', 'video/webm');
      res.setHeader('Content-Length', size);
      fs.createReadStream(videoFile).pipe(res);
    } else { res.writeHead(404); res.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: path.resolve(options.browser), headless: true,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const result = { at: new Date().toISOString(), browser: browser.version(), video: path.basename(videoFile),
      videoSha256: crypto.createHash('sha256').update(fs.readFileSync(videoFile)).digest('hex'),
      controllerSha256: crypto.createHash('sha256').update(controllerSource).digest('hex'),
      platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
      mode, environment: 'Headless local Chromium; fully fetched Blob; silent WAV audio master; no BBB server', cases: [] };
    const cases = mode === 'sweep' ? [3, 4, 8, 12, 16, 32] : (options.policies || 'current,fast8,fast12,fast16').split(',');
    if (mode === 'recovery') assert(cases.every(policy => /^(current|fast(?:4|8|12|16))$/.test(policy)), 'Unknown experimental policy');
    for (const policy of cases) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const row = await page.evaluate(async config => {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const waitFor = async (predicate, description) => {
          const start = performance.now();
          while (!predicate()) {
            if (performance.now() - start > 60000) throw new Error('Timed out: ' + description);
            await delay(20);
          }
        };
        const currentRate = new Function('return (' + config.controller + ')')();
        const video = document.querySelector('video');
        const blob = await (await fetch('/fixture.webm')).blob();
        video.src = URL.createObjectURL(blob);
        video.preload = 'auto';
        await waitFor(() => video.readyState >= 2, 'metadata and first frame');
        const duration = video.duration;
        if (duration < 115) throw new Error('Use a fixture at least 115 seconds long');
        const origin = video.currentTime;
        video.currentTime = origin + 20;
        await waitFor(() => !video.seeking && video.readyState >= 2, 'initial position');
        const ahead = () => {
          for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
              return video.buffered.end(i) - video.currentTime;
            }
          }
          return 0;
        };
        await waitFor(() => ahead() >= duration - video.currentTime - 0.5, 'whole fixture buffered');
        // An independent native audio element supplies the master timeline.
        // Silent content keeps the benchmark unobtrusive, but its clock is real.
        const wav = new ArrayBuffer(44 + 8000 * Math.ceil(duration + 120) * 2);
        const view = new DataView(wav);
        const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        text(36, 'data'); view.setUint32(40, wav.byteLength - 44, true);
        const audio = document.createElement('audio');
        audio.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
        document.body.appendChild(audio);
        await waitFor(() => audio.readyState >= 2, 'audio');
        const base = config.base;
        audio.playbackRate = base;
        const initialVideo = video.currentTime;
        const lag = config.mode === 'recovery' ? config.lag : 0;
        audio.currentTime = initialVideo + lag;
        await waitFor(() => !audio.seeking, 'audio position');
        const support = [];
        let targetRate = config.mode === 'sweep' ? config.policy : base;
        try { video.playbackRate = targetRate; support.push({ requested: targetRate, accepted: video.playbackRate }); }
        catch (error) { return { policy: config.policy, supported: false, error: error.name, message: error.message }; }
        const frames = [], samples = [], events = [], decisions = [];
        let alive = true, latest = null;
        const frame = (now, metadata) => {
          latest = { wall: now, time: metadata.mediaTime, presented: metadata.presentedFrames,
            processingS: metadata.processingDuration ?? null };
          frames.push(latest);
          if (alive) video.requestVideoFrameCallback(frame);
        };
        if (!video.requestVideoFrameCallback) throw new Error('Frame callback API is required for this experiment');
        video.requestVideoFrameCallback(frame);
        for (const name of ['waiting', 'playing', 'seeking', 'seeked', 'stalled', 'ended', 'error']) {
          video.addEventListener(name, () => events.push({ wall: performance.now(), name, time: video.currentTime, ahead: ahead() }));
        }
        let audioPauses = 0, audioRateChanges = 0;
        audio.addEventListener('pause', () => audioPauses++);
        audio.addEventListener('ratechange', () => audioRateChanges++);
        // Drain setup events before defining the measured interval.
        await delay(100);
        audioPauses = 0; audioRateChanges = 0;
        const qualityStart = video.getVideoPlaybackQuality();
        await audio.play();
        await video.play();
        const start = performance.now(), audioStart = audio.currentTime;
        let recoveredAt = null, stableSince = null;
        const timer = setInterval(() => {
          const now = performance.now();
          const drift = audio.currentTime - video.currentTime;
          if (config.mode === 'recovery') {
            targetRate = currentRate(base, drift, ahead());
            const cap = Number(String(config.policy).replace('fast', ''));
            if (config.policy !== 'current' && drift > 2 && video.readyState >= 3 && !video.seeking) {
              // Experimental envelope ONLY. Not the proposed final controller.
              // A 2 s remaining lag bounds overshoot until the normal tail takes over.
              targetRate = Math.max(targetRate, Math.min(cap, base + (drift - 1) / 0.5, ahead() / 2));
            }
            if (video.playbackRate !== targetRate) {
              decisions.push({ wall: now - start, drift, ahead: ahead(), rate: targetRate });
              video.playbackRate = targetRate;
            }
          }
          const frameDrift = latest === null ? null : audio.currentTime - latest.time;
          samples.push({ wall: now - start, audio: audio.currentTime, video: video.currentTime, drift,
            rate: video.playbackRate, ahead: ahead(), ready: video.readyState, seeking: video.seeking,
            frame: latest?.time ?? null, frameAgeMs: latest === null ? null : now - latest.wall, frameDrift });
          if (Math.abs(drift) <= 0.15 && frameDrift !== null && Math.abs(frameDrift) <= 0.3 && video.playbackRate === base) {
            if (stableSince === null) stableSince = now;
            if (now - stableSince >= 750 && recoveredAt === null) recoveredAt = stableSince - start;
          } else stableSince = null;
        }, 100);
        while (performance.now() - start < (config.mode === 'sweep' ? config.seconds : 75) * 1000 &&
          recoveredAt === null && !video.ended) await delay(50);
        clearInterval(timer);
        const finish = performance.now(), audioFinish = audio.currentTime, quality = video.getVideoPlaybackQuality();
        const audioStillPlaying = !audio.paused, audioRate = audio.playbackRate;
        alive = false;
        const active = frames.filter(frame => frame.wall >= start + 500);
        const first = active[0], last = active.at(-1);
        const seconds = (finish - start) / 1000;
        const slope = first && last && last.wall > first.wall ? (last.time - first.time) / ((last.wall - first.wall) / 1000) : null;
        let waitingAt = null, waitingMs = 0;
        for (const event of events) {
          if (event.name === 'waiting' && waitingAt === null) waitingAt = Math.max(start, event.wall);
          if ((event.name === 'playing' || event.name === 'ended') && waitingAt !== null) {
            waitingMs += Math.max(0, event.wall - waitingAt); waitingAt = null;
          }
        }
        if (waitingAt !== null) waitingMs += finish - waitingAt;
        const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
        const summary = {
          policy: config.policy, supported: true, base, lag, duration, origin, seconds: round(seconds),
          recoveredS: recoveredAt === null ? null : round(recoveredAt / 1000),
          frameAdvanceRate: round(slope), frameCallbacks: active.length,
          minBufferS: round(Math.min(...samples.map(sample => sample.ahead))),
          maxVideoRate: Math.max(...samples.map(sample => sample.rate)),
          finalClockDriftS: round(samples.at(-1)?.drift), finalFrameDriftS: round(samples.at(-1)?.frameDrift),
          maxFrameAgeMs: round(Math.max(...samples.map(sample => sample.frameAgeMs ?? 0))),
          seeks: events.filter(event => event.wall >= start && event.name === 'seeking').length,
          waits: events.filter(event => event.wall >= start && event.name === 'waiting').length,
          waitingMs: round(waitingMs),
          totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames,
          intervalTotalFrames: quality.totalVideoFrames - qualityStart.totalVideoFrames,
          intervalDroppedFrames: quality.droppedVideoFrames - qualityStart.droppedVideoFrames,
          audioPauses, audioRateChanges, audioStillPlaying, audioRate,
          audioAdvancePerWallS: round((audioFinish - audioStart) / seconds), support,
        };
        // End the measured interval before stopping the isolated test elements.
        video.pause(); audio.pause();
        return { ...summary, samples, frames: active.map(frame => ({ ...frame, wall: frame.wall - start })),
          events: events.map(event => ({ ...event, wall: event.wall - start })), decisions };
      }, { mode, policy, controller: synchronizationRate.toString(), base: Number(options['audio-rate'] || 1),
        lag: Number(options.lag || 60), seconds: Number(options.seconds || 4) });
      assert.deepEqual(errors, []);
      if (row.supported) {
        assert.equal(row.audioPauses, 0, 'Master audio must not be paused');
        assert.equal(row.audioRateChanges, 0, 'Master audio rate must not change');
        assert.equal(row.audioStillPlaying, true);
        assert.equal(row.audioRate, Number(options['audio-rate'] || 1));
        assert.equal(row.seeks, 0, 'No corrective seek is allowed during the experiment');
        assert(row.frameCallbacks > 0, 'Must observe actual submitted frames');
      }
      result.cases.push(row);
      const { samples, frames, events, decisions, ...summary } = row;
      console.log(JSON.stringify(summary));
      fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n');
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
