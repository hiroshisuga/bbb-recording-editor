#!/usr/bin/env node
// Research only: compare native buffered time with received byte ranges.
// All files stay local. Playwright is an optional, separately installed tool.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  const { values: options } = parseArgs({ options: Object.fromEntries(
    ['finite', 'live', 'vbr', 'browser', 'playwright', 'output'].map(name => [name, { type: 'string' }])) });
  if (!options.browser || !options.output || !['finite', 'live', 'vbr'].some(key => options[key])) {
    throw new Error('Usage: node scripts/benchmark-buffer-reporting.cjs --browser CHROMIUM --output results.json [--playwright MODULE_PATH] [--finite FILE] [--live FILE] [--vbr FILE]');
  }
  const files = new Map(['finite', 'live', 'vbr'].filter(key => options[key]).map(key => [key, path.resolve(options[key])]));
  for (const file of files.values()) fs.statSync(file);
  const cases = [...files.keys()].map(key => ({ key, mode: 'http' }));
  if (files.has('vbr')) cases.push({ key: 'vbr', mode: 'blob' }, { key: 'vbr', mode: 'offline' });
  if (files.has('live')) cases.push({ key: 'live', mode: 'offline' });
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Native buffer reporting</title><video muted preload="auto" style="width:640px;height:360px"></video>');
      return;
    }
    const key = req.url?.match(/^\/fixture\/(finite|live|vbr)\.webm$/)?.[1];
    if (!files.has(key)) { res.writeHead(404); res.end(); return; }
    const file = files.get(key), size = fs.statSync(file).size;
    let start = 0, end = size - 1;
    if (req.headers.range) {
      const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) { res.writeHead(416); res.end(); return; }
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
      if (start > end) { res.writeHead(416); res.end(); return; }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', end - start + 1);
    const stream = fs.createReadStream(file, { start, end });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  const { chromium } = require(options.playwright || 'playwright');
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: path.resolve(options.browser), headless: true,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const output = { at: new Date().toISOString(), browser: browser.version(),
      scope: 'Synthetic local files; HTTP/Blob comparison; offline cached playback; not a BBB recording', cases: [] };
    for (const test of cases) {
      const page = await browser.newPage(), cdp = await page.context().newCDPSession(page);
      const requests = new Map();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', event => {
        if (event.request.url.includes('/fixture/')) requests.set(event.requestId,
          { range: event.request.headers.Range ?? null, bytes: 0, finished: false });
      });
      cdp.on('Network.responseReceived', event => {
        const entry = requests.get(event.requestId);
        if (entry) Object.assign(entry, { status: event.response.status, responseRange:
          Object.entries(event.response.headers).find(([key]) => key.toLowerCase() === 'content-range')?.[1] ?? null });
      });
      cdp.on('Network.dataReceived', event => { const entry = requests.get(event.requestId); if (entry) entry.bytes += event.dataLength; });
      cdp.on('Network.loadingFinished', event => { const entry = requests.get(event.requestId); if (entry) entry.finished = true; });
      cdp.on('Network.loadingFailed', event => { const entry = requests.get(event.requestId); if (entry) entry.failure = event.errorText; });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const evaluation = page.evaluate(async ({ key, mode }) => {
        const video = document.querySelector('video'), events = [], samples = [];
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const snapshot = () => {
          const buffered = Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]);
          const range = buffered.find(([start, end]) => start <= video.currentTime && video.currentTime <= end);
          return { wall: performance.now(), duration: Number.isFinite(video.duration) ? video.duration : String(video.duration),
            time: video.currentTime, ahead: range ? range[1] - video.currentTime : 0,
            ready: video.readyState, network: video.networkState, seeking: video.seeking, buffered,
            decodedBytes: video.webkitVideoDecodedByteCount ?? null, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames };
        };
        const wait = async predicate => {
          const start = performance.now();
          while (!predicate()) { if (performance.now() - start > 30000) throw new Error('Timed out: ' + JSON.stringify(snapshot())); await delay(25); }
        };
        for (const name of ['progress', 'suspend', 'stalled', 'durationchange', 'loadedmetadata', 'seeked', 'waiting', 'canplay', 'playing']) {
          video.addEventListener(name, () => events.push({ event: name, ...snapshot() }));
        }
        const source = `/fixture/${key}.webm`;
        video.src = mode === 'blob' ? URL.createObjectURL(await (await fetch(source)).blob()) : source;
        await wait(() => video.readyState >= 2);
        if (Number.isFinite(video.duration) && video.duration < 180) throw new Error('Use a fixture at least 180 seconds long');
        video.currentTime = 120;
        await wait(() => !video.seeking && video.readyState >= 2);
        const initial = snapshot();
        for (let i = 0; i < 8; i++) { await delay(500); samples.push(snapshot()); }
        const paused = snapshot();
        if (mode === 'offline') {
          window.offlineReady = true;
          await wait(() => window.offlineApplied);
          video.playbackRate = 4;
        }
        await video.play();
        for (let i = 0; i < (mode === 'offline' ? 24 : 8); i++) { await delay(500); samples.push(snapshot()); }
        video.pause();
        return { initial, paused, final: snapshot(), events, samples };
      }, test);
      if (test.mode === 'offline') {
        await page.waitForFunction(() => window.offlineReady);
        await page.context().setOffline(true);
        await page.evaluate(() => { window.offlineApplied = true; });
      }
      const row = { ...test, file: path.basename(files.get(test.key)), fileBytes: fs.statSync(files.get(test.key)).size,
        ...await evaluation, requests: [...requests.values()] };
      // Prefix reception is a byte-level measurement, not a buffered-time guess.
      // Packet positions allow comparing that received prefix with actual media PTS.
      const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'packet=pts_time,pos,size', '-of', 'json', files.get(test.key)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).packets;
      const ranges = row.requests.filter(request => request.responseRange).map(request => {
        const start = Number(request.responseRange.match(/^bytes (\d+)-/)[1]);
        return [start, start + request.bytes];
      });
      let receivedPrefixMediaEnd = null;
      for (const packet of packets) {
        const position = Number(packet.pos), size = Number(packet.size);
        if (!ranges.some(([start, end]) => start <= position && position + size <= end)) break;
        receivedPrefixMediaEnd = Number(packet.pts_time);
      }
      row.receivedPrefixMediaEnd = receivedPrefixMediaEnd;
      if (test.mode === 'offline') assert(row.final.time - row.paused.time > 40,
        'Offline playback should advance beyond the few seconds reported by buffered');
      output.cases.push(row);
      const { events, samples, ...summary } = row;
      console.log(JSON.stringify(summary));
      fs.writeFileSync(path.resolve(options.output), JSON.stringify(output, null, 2) + '\n');
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
