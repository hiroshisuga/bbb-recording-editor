import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import VideoPreview from './VideoPreview';
import { EditorLanguageProvider, LANGUAGE_KEY } from './i18n';

let container, root, props, clock;
const states = new WeakMap();
const state = video => {
  if (!states.has(video)) states.set(video, { time: 0, ready: 0, seeking: false, paused: true, duration: 30, writes: [], ranges: [[0, 100]] });
  return states.get(video);
};
const clip = { id: 'screen-one', kind: 'deskshare', start_ms: 1000, end_ms: 31000,
  start_pts: 0, url: '/raw/deskshare/one.webm', relative: 'deskshare/one.webm' };
const video = () => container.querySelector('video');
async function render(changes = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<EditorLanguageProvider><VideoPreview {...props} /></EditorLanguageProvider>));
}
async function event(name, values = {}) {
  Object.assign(state(video()), values);
  await act(async () => video().dispatchEvent(new Event(name)));
}

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem(LANGUAGE_KEY, 'en');
  clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  for (const [name, key] of Object.entries({ currentTime: 'time', readyState: 'ready', seeking: 'seeking', paused: 'paused', duration: 'duration' })) {
    jest.spyOn(HTMLMediaElement.prototype, name, 'get').mockImplementation(function get() { return state(this)[key]; });
  }
  jest.spyOn(HTMLMediaElement.prototype, 'buffered', 'get').mockImplementation(function get() {
    const ranges = state(this).ranges;
    return { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] };
  });
  jest.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(function set(value) {
    const media = state(this);
    if (!media.ready) throw new DOMException('Metadata not loaded', 'InvalidStateError');
    media.time = value; media.seeking = true; media.writes.push(value);
  });
  jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function load() {
    Object.assign(state(this), { ready: 0, time: 0, seeking: false, paused: true });
  });
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function pause() { state(this).paused = true; });
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function play() { state(this).paused = false; return Promise.resolve(); });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  props = { clip, time: 1000, playing: false, rate: 1 };
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); localStorage.clear(); jest.restoreAllMocks();
});

test('waits for metadata and applies the latest paused seek even when no more audio ticks arrive', async () => {
  await render({ time: 6000 });
  expect(state(video()).writes).toEqual([]);
  await render({ time: 11000 });
  expect(state(video()).writes).toEqual([]);
  await event('loadedmetadata', { ready: 1 });
  expect(state(video()).writes).toEqual([10]);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

test.each(['deskshare', 'video'])('nonzero raw container timestamps are included when seeking %s', async kind => {
  await render({ clip: { ...clip, kind, start_pts: 600 }, time: 3500, playing: true });
  await event('loadedmetadata', { ready: 1, duration: 630, time: 600 });
  expect(state(video()).writes).toEqual([602.5]);
  expect(video().muted).toBe(true);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  await event('seeked', { seeking: false, ready: 4 });
  await render({ time: 11000, playing: false });
  expect(state(video()).writes).toEqual([602.5, 610]);
  expect(state(video()).paused).toBe(true);
});

test('a slow seek can finish and render before following the moving audio clock', async () => {
  await render({ time: 3000, playing: true });
  await event('loadedmetadata', { ready: 1 });
  expect(state(video()).writes).toEqual([2]);
  await render({ time: 3100 }); await render({ time: 3500 }); await render({ time: 6000 });
  expect(state(video()).writes).toEqual([2]);
  await event('seeked', { ready: 4, seeking: false });
  expect(state(video()).writes).toEqual([2]);
  clock = 1000;
  await render({ time: 6100 });
  expect(state(video()).writes).toEqual([2]);
  expect(video().playbackRate).toBeGreaterThan(1);
  await event('seeked', { seeking: false });
  expect(state(video()).writes).toEqual([2]);
});

test('normal playback advances without repeated play calls or seeks, and rate changes do not restart playback', async () => {
  await render({ playing: true });
  await event('loadedmetadata', { ready: 4 });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  for (const time of [1100, 1200, 1300, 1400]) {
    state(video()).time = (time - clip.start_ms) / 1000;
    await render({ time });
  }
  await render({ rate: 1.5 });
  expect(video().playbackRate).toBe(1.5);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  expect(state(video()).writes).toEqual([]);
});

test('keeps a single pending play request, shows rejection details, and reloads on explicit retry', async () => {
  let reject;
  HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise((resolve, failure) => { reject = failure; }));
  await render({ playing: true }); await event('loadedmetadata', { ready: 4 });
  await render({ time: 1100 }); await event('canplay');
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  await act(async () => reject(new DOMException('Playback blocked', 'NotAllowedError')));
  expect(container.querySelector('[role="alert"]').textContent).toContain('NotAllowedError: Playback blocked');
  await render({ time: 1200 }); await event('canplay');
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  const old = video();
  await act(async () => Simulate.click(container.querySelector('button')));
  expect(video()).not.toBe(old);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await event('loadedmetadata', { ready: 4 });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

test('pausing a pending play and replacing a source do not surface stale playback errors', async () => {
  let reject;
  HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise((resolve, failure) => { reject = failure; }));
  await render({ playing: true }); await event('loadedmetadata', { ready: 4 });
  const old = video();
  await render({ playing: false });
  await render({ clip: { ...clip, url: '/raw/deskshare/two.webm' } });
  await act(async () => reject(new DOMException('Source replaced', 'NotSupportedError')));
  expect(state(old).paused).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(state(video()).writes).toEqual([]);
});

test('decoder and network errors show the file and native error instead of a silent blank frame', async () => {
  await render();
  Object.defineProperty(video(), 'error', { configurable: true, value: { code: 3, message: 'Decode failed' } });
  await event('error');
  expect(container.querySelector('[role="alert"]').textContent).toContain('deskshare/one.webm');
  expect(container.querySelector('[role="alert"]').textContent).toContain('Decode failed');
  expect(container.querySelector('button').textContent).toBe('Reload video');
});

test('paused fine seeks update at sub-200ms steps and clamp to media duration; negative origins stay at zero', async () => {
  await render({ clip: { ...clip, start_pts: -0.007 } });
  await event('loadedmetadata', { ready: 4 });
  await render({ time: 1050 });
  expect(state(video()).writes).toEqual([0.05]);
  await event('seeked', { seeking: false });
  await render({ time: 40000 });
  expect(state(video()).writes[1]).toBeCloseTo(29.999);
});

test('a new user destination cancels the old raw-media load, coalesces updates, and resumes at the latest target', async () => {
  await render({ time: 3000, playing: true, seekVersion: 0 });
  await event('loadedmetadata', { ready: 1 });
  expect(state(video()).writes).toEqual([2]);
  await render({ time: 21000, seekVersion: 1 });
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  expect(state(video()).ready).toBe(0);
  await render({ time: 21100 }); await render({ time: 21500 });
  await render({ time: 9000, seekVersion: 2 });
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  await event('loadedmetadata', { ready: 1 });
  expect(state(video()).writes).toEqual([2, 8]);
  await render({ time: 9100 });
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  expect(state(video()).writes).toEqual([2, 8]);
  await event('seeked', { ready: 4, seeking: false });
  expect(state(video()).writes).toEqual([2, 8]);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});

test.each([false, true])('explicit fine seeks use the requested position even below playback drift tolerance (playing=%s)', async playing => {
  await render({ time: 2000, playing, seekVersion: 0 });
  await event('loadedmetadata', { ready: 4 });
  await event('seeked', { seeking: false });
  await render({ time: 2050, seekVersion: 1 });
  expect(state(video()).writes).toEqual([1, 1.05]);
  // Repeated requests for the same pending destination do not restart decoding.
  await render({ seekVersion: 2 });
  expect(state(video()).writes).toEqual([1, 1.05]);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
});

test('seeks requested while metadata is loading are coalesced to the latest destination and retain the raw clock offset', async () => {
  await render({ clip: { ...clip, start_pts: 600 }, time: 3000, seekVersion: 0 });
  await render({ time: 21000, seekVersion: 1 }); await render({ time: 9000, seekVersion: 2 });
  expect(state(video()).writes).toEqual([]);
  await event('loadedmetadata', { ready: 4, duration: 630, time: 600 });
  expect(state(video()).writes).toEqual([608]);
});

test('initial native seeking is allowed to finish without reloading the video on mount', async () => {
  await render({ clip: { ...clip, start_pts: 600 }, time: 3500, seekVersion: 7 });
  await event('loadedmetadata', { ready: 1, duration: 630, time: 600, seeking: true });
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  await event('seeked', { seeking: false, ready: 4 });
  expect(state(video()).writes).toEqual([602.5]);
});

test('rejections from a cancelled raw-media load cannot override a new play request', async () => {
  let rejectOld, resolveNew;
  HTMLMediaElement.prototype.play
    .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  await render({ time: 3000, playing: true, seekVersion: 0 });
  await event('loadedmetadata', { ready: 1 });
  await render({ time: 21000, seekVersion: 1 });
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  await event('loadedmetadata', { ready: 1 });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  await act(async () => rejectOld(new DOMException('Obsolete load failed', 'NotSupportedError')));
  await event('canplay', { ready: 4 });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  await act(async () => resolveNew());
});


test('buffer starvation never starts automatic seeks, even as the audio clock keeps advancing', async () => {
  await render({ playing: true }); await event('loadedmetadata', { ready: 1 });
  for (const ready of [1, 2]) {
    clock += 5000;
    await event('waiting', { ready });
    await render({ time: clock + 1000 });
  }
  expect(state(video()).writes).toEqual([]);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  // A stale waiting flag also prevents correction until playback becomes ready.
  await render({ time: 12000 }); state(video()).ready = 4;
  await render({ time: 12100 });
  expect(state(video()).writes).toEqual([]);
  await event('canplay');
  expect(state(video()).writes).toEqual([]);
  expect(video().playbackRate).toBe(3);
  expect(state(video()).paused).toBe(false);
});

test('small drift adjusts only the video rate, returns to the requested rate, and respects its direction', async () => {
  await render({ playing: true, rate: 2 }); await event('loadedmetadata', { ready: 4 });
  clock = 1000;
  await render({ time: 1400 });
  expect(video().playbackRate).toBeCloseTo(2.7);
  await event('waiting');
  expect(video().playbackRate).toBe(2);
  state(video()).time = 0.8; await event('canplay');
  expect(video().playbackRate).toBeCloseTo(1.8);
  state(video()).time = 0.4; await render({ time: 1450 });
  expect(video().playbackRate).toBe(2);
  expect(state(video()).writes).toEqual([]);
});

test('large drift never causes automatic seeks or reloads, and an explicit seek remains immediate', async () => {
  await render({ playing: true }); await event('loadedmetadata', { ready: 4, duration: 200 });
  for (const at of [1000, 10000, 13000, 60000]) {
    clock = at; await render({ time: at + 3000 });
    expect(state(video()).writes).toEqual([]);
    expect(video().playbackRate).toBeGreaterThan(1);
    expect(video().playbackRate).toBeLessThanOrEqual(3);
  }
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  await render({ time: 6000, seekVersion: 1 });
  expect(state(video()).writes).toEqual([5]);
  expect(video().playbackRate).toBe(1);
});

async function lagAt(at, lag = 2) {
  clock = at;
  state(video()).time = at / 1000 - lag;
  await render({ time: at + 1000 });
}

test('persistent screen drift warns after ten seconds, clears on recovery, and can be dismissed for the source', async () => {
  await render({ playing: true }); await event('loadedmetadata', { ready: 4, duration: 100 });
  for (const at of [4000, 8000, 12000]) await lagAt(at);
  expect(container.querySelector('[role="status"]')).toBeNull();
  await lagAt(16000);
  expect(container.querySelector('[role="status"]').textContent).toContain('Audio playback continues');
  await lagAt(18000, 0.1);
  expect(container.querySelector('[role="status"]')).toBeNull();
  await lagAt(20000); await lagAt(30000);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => Simulate.click(container.querySelector('button')));
  await lagAt(32000, 0.1); await lagAt(34000); await lagAt(46000);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(state(video()).writes).toEqual([]);
  await render({ clip: { ...clip, url: '/raw/deskshare/two.webm' } });
  await event('loadedmetadata', { ready: 4, duration: 100, time: 46 });
  await lagAt(50000); await lagAt(60000);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

test('manual seeks and paused positioning never count as automatic corrections', async () => {
  await render({ playing: true }); await event('loadedmetadata', { ready: 4 });
  for (let i = 1; i <= 10; i++) {
    clock = i * 4000;
    await render({ time: i * 2000, seekVersion: i, playing: i % 2 === 0 });
    await event('seeked', { seeking: false });
  }
  expect(state(video()).writes.length).toBeGreaterThan(4);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('brief drifts and pauses reset the persistent-drift observation period', async () => {
  await render({ playing: true }); await event('loadedmetadata', { ready: 4, duration: 100 });
  await lagAt(4000); await lagAt(12000); await lagAt(13000, 0.1);
  await lagAt(16000); await lagAt(24000);
  expect(container.querySelector('[role="status"]')).toBeNull();
  await render({ playing: false }); await event('seeked', { seeking: false });
  await render({ playing: true });
  await lagAt(28000); await lagAt(36000);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('cameras show compact diagnostics while retaining normal correction and no screen-sharing warning', async () => {
  await render({ clip: { ...clip, kind: 'video' }, playing: true });
  await event('loadedmetadata', { ready: 4 });
  for (const at of [4000, 8000, 12000, 16000]) await lagAt(at);
  expect(state(video()).writes).toEqual([]);
  expect(video().playbackRate).toBeGreaterThan(1);
  expect(container.querySelector('.re-video-buffer--compact')).not.toBeNull();
  expect(container.querySelector('.re-video-buffer').parentElement).toBe(container.querySelector('.re-video'));
  expect(container.querySelector('.re-video-image').contains(container.querySelector('.re-video-buffer'))).toBe(false);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('trace identifies rate-based sync and logs explicit seeks without any automatic seek request', async () => {
  window.bbbEditorVideoDebug = true;
  jest.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await render({ playing: true });
    Object.defineProperty(video(), 'buffered', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 1.5 }) });
    await event('loadedmetadata', { ready: 4 });
    clock = 1000; await render({ time: 3000 });
    expect(window.bbbEditorVideoLogs.some(r => r.event === 'seek-request')).toBe(false);
    expect(window.bbbEditorVideoLogs.some(r => r.syncPolicy === 'progress-based-playback-rate')).toBe(true);
    await render({ time: 5000, seekVersion: 1 });
    const request = window.bbbEditorVideoLogs.find(r => r.event === 'seek-request');
    const assigned = window.bbbEditorVideoLogs.find(r => r.event === 'seek-assigned');
    expect(request).toEqual(expect.objectContaining({ reason: 'user-seek', videoTimeS: 0, targetTimeS: 4, bufferAheadS: 1.5, targetBufferAheadS: 0 }));
    expect(assigned).toEqual(expect.objectContaining({ reason: 'user-seek', videoTimeS: 4, bufferAheadS: 0, seeking: true }));
    expect(window.bbbEditorVideoLogs.filter(r => r.event === 'seek-request').map(r => r.reason)).toEqual(['user-seek']);
  } finally {
    delete window.bbbEditorVideoDebug; delete window.bbbEditorVideoLogs;
  }
});


test.each([1, 2])('a slow-seek backlog converges by rate with an uninterrupted master clock at %sx', async rate => {
  await render({ playing: true, rate });
  await event('loadedmetadata', { ready: 4, duration: 300 });
  let master = 20;
  state(video()).ranges = [[0, 300]];
  for (let i = 0; i < 400; i++) {
    clock += 100;
    master += rate * 0.1;
    state(video()).time += video().playbackRate * 0.1;
    await render({ time: 1000 + master * 1000 });
  }
  expect(Math.abs(master - state(video()).time)).toBeLessThan(0.2);
  expect(video().playbackRate).toBe(rate);
  expect(state(video()).writes).toEqual([]);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  expect(master).toBeCloseTo(20 + 40 * rate);
});

test('catch-up respects available buffering and returns to the user rate on pause and readiness loss', async () => {
  await render({ playing: true, rate: 2 }); await event('loadedmetadata', { ready: 4 });
  state(video()).ranges = [[0, 5]]; clock = 1000;
  await render({ time: 11000 });
  expect(video().playbackRate).toBe(2.5);
  state(video()).ranges = [[0, 2]]; clock = 2000;
  await render({ time: 12000 });
  expect(video().playbackRate).toBe(2);
  state(video()).ranges = [[0, 100]];
  await event('progress'); await render({ time: 13000 });
  expect(video().playbackRate).toBe(4);
  await event('waiting', { ready: 2 });
  expect(video().playbackRate).toBe(2);
  await event('canplay', { ready: 4 });
  expect(video().playbackRate).toBe(4);
  await render({ playing: false });
  expect(video().playbackRate).toBe(2);
});


test.each([1, 2])('a video far ahead slows down without seeking backward (master %sx)', async rate => {
  await render({ playing: true, rate }); await event('loadedmetadata', { ready: 4, duration: 200 });
  state(video()).time = 80; clock = 1000;
  await render({ time: 21000 });
  expect(video().playbackRate).toBe(rate * 0.5);
  expect(state(video()).writes).toEqual([]);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
});

async function withFrameCallbacks(run) {
  const prototype = HTMLVideoElement.prototype;
  const names = ['requestVideoFrameCallback', 'cancelVideoFrameCallback'];
  const original = names.map(name => Object.getOwnPropertyDescriptor(prototype, name));
  let callback = null;
  const request = jest.fn(fn => { callback = fn; return 1; });
  const cancel = jest.fn(() => { callback = null; });
  names.forEach((name, i) => Object.defineProperty(prototype, name, { configurable: true, value: [request, cancel][i] }));
  try { await run({ request, cancel, frame: () => { const fn = callback; callback = null; fn?.(clock, { mediaTime: state(video()).time }); } }); }
  finally {
    await render({ clip: null });
    names.forEach((name, i) => { if (original[i]) Object.defineProperty(prototype, name, original[i]); else delete prototype[name]; });
  }
}

test('screen preview applies measured rates above 4x, converges, and cancels observations on a user seek', async () => {
  await withFrameCallbacks(async ({ frame, cancel }) => {
    await render({ playing: true, time: 21000, seekVersion: 0 });
    await event('loadedmetadata', { ready: 4, duration: 1000, ranges: [[0, 1000]], time: 20 });
    let master = 80, maximum = 1;
    for (let i = 1; i <= 170; i++) {
      clock = i * 100; master += 0.1;
      state(video()).time += video().playbackRate * 0.1;
      frame(); await render({ time: 1000 + master * 1000 });
      maximum = Math.max(maximum, video().playbackRate);
    }
    expect(maximum).toBe(12);
    expect(Math.abs(master - state(video()).time)).toBeLessThanOrEqual(0.15);
    expect(video().playbackRate).toBe(1);
    expect(state(video()).writes).toEqual([]);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    // Start a new recovery episode, then interrupt its live frame observer.
    await render({ time: 501000 });
    expect(video().playbackRate).toBe(3);
    const cancelled = cancel.mock.calls.length;
    await render({ time: 51000, seekVersion: 1 });
    expect(video().playbackRate).toBe(1);
    expect(state(video()).writes).toEqual([50]);
    expect(cancel).toHaveBeenCalledTimes(cancelled + 1);
  });
});

test('camera previews retain the normal rate ceiling even when frame callbacks are available', async () => {
  await withFrameCallbacks(async ({ request }) => {
    await render({ playing: true, clip: { ...clip, kind: 'video' } });
    await event('loadedmetadata', { ready: 4, duration: 1000, ranges: [[0, 1000]] });
    clock = 1000; await render({ time: 61000 });
    expect(video().playbackRate).toBe(3);
    expect(request).not.toHaveBeenCalled();
  });
});

test.each([3, 4])('a browser rejecting rates above %sx keeps playing and does not retry the rejected rate', async ceiling => {
  await withFrameCallbacks(async ({ frame }) => {
    let rate = 1;
    const writes = [];
    await render({ playing: true });
    Object.defineProperty(video(), 'playbackRate', {
      configurable: true, get: () => rate,
      set(value) {
        writes.push(value);
        if (value > ceiling) throw new DOMException('Unsupported speed', 'NotSupportedError');
        rate = value;
      },
    });
    await event('loadedmetadata', { ready: 4, duration: 1000, ranges: [[0, 1000]] });
    let master = 200;
    for (let i = 1; i <= 180; i++) {
      clock = i * 100; master += 0.1;
      state(video()).time += rate * 0.1;
      frame(); await render({ time: 1000 + master * 1000 });
    }
    expect(writes.filter(value => value > ceiling)).toEqual([ceiling === 3 ? 4 : 6]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(state(video()).paused).toBe(false);
    expect(state(video()).writes).toEqual([]);
  });
});

test('screen recovery can progress when the browser continually reports only a 2.5-second queue', async () => {
  await withFrameCallbacks(async ({ frame }) => {
    await render({ playing: true, time: 21000 });
    await event('loadedmetadata', { ready: 4, duration: 1000, ranges: [[20, 22.5]], time: 20 });
    let master = 80, maximum = 1;
    for (let i = 1; i <= 300; i++) {
      clock = i * 100; master += 0.1;
      state(video()).time += video().playbackRate * 0.1;
      state(video()).ranges = [[20, state(video()).time + 2.5]];
      frame(); await render({ time: 1000 + master * 1000 });
      maximum = Math.max(maximum, video().playbackRate);
    }
    expect(maximum).toBeGreaterThan(4);
    expect(Math.abs(master - state(video()).time)).toBeLessThanOrEqual(0.15);
    expect(video().playbackRate).toBe(1);
    expect(state(video()).writes).toEqual([]);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  });
});

test('a brief media wait rechecks progress and recovers the tail without extra seeks', async () => {
  await withFrameCallbacks(async ({ frame }) => {
    await render({ playing: true, time: 21000 });
    await event('loadedmetadata', { ready: 4, duration: 1000, ranges: [[0, 1000]], time: 20 });
    let master = 80;
    const tick = async () => {
      clock += 100; master += 0.1;
      state(video()).time += video().playbackRate * 0.1;
      frame(); await render({ time: 1000 + master * 1000 });
    };
    for (let i = 0; i < 30 && video().playbackRate < 4; i++) await tick();
    expect(video().playbackRate).toBe(4);
    master = state(video()).time + 2.4;
    state(video()).ranges = [[0, state(video()).time + 2.5]];
    await render({ time: 1000 + master * 1000 });
    await event('waiting', { ready: 2 });
    expect(video().playbackRate).toBe(1);
    clock += 11; master += 0.011;
    await event('canplay', { ready: 4 });
    // Apply the new master clock without interpreting it as a user seek.
    await render({ time: 1000 + master * 1000 });
    expect(video().playbackRate).toBe(1.25);
    let accelerated = false;
    for (let i = 0; i < 80; i++) {
      state(video()).ranges = [[0, state(video()).time + 2.5]];
      await tick();
      if (i < 19) expect(video().playbackRate).toBeLessThanOrEqual(1.25);
      accelerated ||= video().playbackRate > 1.25;
    }
    expect(accelerated).toBe(true);
    expect(Math.abs(master - state(video()).time)).toBeLessThanOrEqual(0.15);
    expect(video().playbackRate).toBe(1);
    expect(state(video()).writes).toEqual([]);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    expect(state(video()).paused).toBe(false);
  });
});

test.each(['deskshare', 'video'])('pausing %s with a 141 ms clock offset does not start a seek', async kind => {
  await render({ clip: { ...clip, kind }, time: 21000, playing: true });
  await event('loadedmetadata', { ready: 4, time: 20, duration: 1000 });
  state(video()).time = 19.859;
  await render({ playing: false });
  await event('canplay'); await event('progress');
  expect(state(video()).paused).toBe(true);
  expect(state(video()).seeking).toBe(false);
  expect(state(video()).writes).toEqual([]);
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  // Editing the paused destination is still exact, even without a version bump.
  await render({ time: 21050 });
  expect(state(video()).writes).toEqual([20.05]);
});

test('initial positioning is precise even inside the pause tolerance, and large pause offsets still align', async () => {
  await render({ time: 1100 });
  await event('loadedmetadata', { ready: 4 });
  expect(state(video()).writes).toEqual([0.1]);
  await event('seeked', { seeking: false });
  await render({ playing: true });
  state(video()).time = 0.5;
  await render({ time: 6100, playing: false });
  expect(state(video()).writes).toEqual([0.1, 5.1]);
});

test('a half-second startup wait permits cautious recovery before thirty seconds without another seek', async () => {
  await withFrameCallbacks(async ({ frame }) => {
    await render({ playing: true, time: 21000 });
    await event('loadedmetadata', { ready: 4, duration: 1000, ranges: [[0, 1000]], time: 20 });
    let master = 89;
    const tick = async () => {
      clock += 100; master += 0.1;
      state(video()).time += video().playbackRate * 0.1;
      frame(); await render({ time: 1000 + master * 1000 });
    };
    clock = 1000; await render({ time: 1000 + master * 1000 });
    expect(video().playbackRate).toBe(3);
    await event('waiting', { ready: 2 });
    for (let i = 0; i < 6; i++) { clock += 100; master += 0.1; await render({ time: 1000 + master * 1000 }); }
    expect(video().playbackRate).toBe(1);
    await event('canplay', { ready: 4 });
    for (let i = 0; i < 19; i++) { await tick(); expect(video().playbackRate).toBe(1); }
    await tick(); expect(video().playbackRate).toBe(1.25);
    for (let i = 0; i < 60; i++) { await tick(); expect(video().playbackRate).toBeLessThanOrEqual(2); }
    expect(video().playbackRate).toBe(2);
    expect(master - state(video()).time).toBeLessThan(69);
    expect(state(video()).writes).toEqual([]);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  });
});

test('each camera reports its own buffer and offset without changing the other camera', async () => {
  await act(async () => root.render(<EditorLanguageProvider>{[1, 2].map(id =>
    <VideoPreview key={id} clip={{ ...clip, kind: 'video', id, user: `Camera ${id}`, url: `/camera-${id}.webm` }} time={6000} playing rate={1} />
  )}</EditorLanguageProvider>));
  const videos = Array.from(container.querySelectorAll('video'));
  await act(async () => videos.forEach(v => {
    Object.assign(state(v), { time: 5, ready: 4 });
    v.dispatchEvent(new Event('loadedmetadata'));
  }));
  await act(async () => {
    Object.assign(state(videos[0]), { ranges: [[0, 15]] });
    Object.assign(state(videos[1]), { time: 3, ranges: [[0, 7]], ready: 2 });
    videos[0].dispatchEvent(new Event('progress'));
    videos[1].dispatchEvent(new Event('waiting'));
  });
  const groups = Array.from(container.querySelectorAll('.re-video-buffer'));
  expect(groups).toHaveLength(2);
  expect(groups[0].textContent).toContain('Buffer: 10.0 s');
  expect(groups[0].textContent).toContain('Offset: about 0 s');
  expect(groups[0].dataset.state).toBe('playing');
  expect(groups[1].textContent).toContain('Buffer: 4.0 s');
  expect(groups[1].textContent).toContain('Behind: 2.0 s');
  expect(groups[1].dataset.state).toBe('waiting');
  expect(state(videos[0]).writes).toEqual([]);
  expect(state(videos[1]).writes).toEqual([]);
});
