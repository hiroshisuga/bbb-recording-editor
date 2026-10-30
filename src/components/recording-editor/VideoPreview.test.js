import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import VideoPreview from './VideoPreview';
import { EditorLanguageProvider, LANGUAGE_KEY } from './i18n';

let container, root, props;
const states = new WeakMap();
const state = video => {
  if (!states.has(video)) states.set(video, { time: 0, ready: 0, seeking: false, paused: true, duration: 30, writes: [] });
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
  for (const [name, key] of Object.entries({ currentTime: 'time', readyState: 'ready', seeking: 'seeking', paused: 'paused', duration: 'duration' })) {
    jest.spyOn(HTMLMediaElement.prototype, name, 'get').mockImplementation(function get() { return state(this)[key]; });
  }
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

test('a slow pending seek is not restarted by every audio tick and seeked applies the latest target', async () => {
  await render({ time: 3000, playing: true });
  await event('loadedmetadata', { ready: 1 });
  expect(state(video()).writes).toEqual([2]);
  await render({ time: 3100 }); await render({ time: 3500 }); await render({ time: 6000 });
  expect(state(video()).writes).toEqual([2]);
  await event('seeked', { ready: 4, seeking: false });
  expect(state(video()).writes).toEqual([2, 5]);
  await event('seeked', { seeking: false });
  expect(state(video()).writes).toEqual([2, 5]);
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
