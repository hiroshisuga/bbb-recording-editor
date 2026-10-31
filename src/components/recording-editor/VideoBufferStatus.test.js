import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import VideoBufferStatus from './VideoBufferStatus';
import { EditorLanguageProvider, LANGUAGE_KEY } from './i18n';

let container, root, video, videoRef, media, props;
const clip = { kind: 'deskshare', url: '/screen.webm', start_ms: 1000, start_pts: 0 };
async function render(changes = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<EditorLanguageProvider><VideoBufferStatus {...props} /></EditorLanguageProvider>));
}
async function event(name, values = {}) {
  Object.assign(media, values);
  await act(async () => video.dispatchEvent(new Event(name)));
}
const status = () => container.querySelector('[role="group"]');

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  localStorage.setItem(LANGUAGE_KEY, 'en');
  media = { time: 5, ready: 4, seeking: false, ended: false, duration: 30, error: null, ranges: [[0, 9]] };
  for (const [name, key] of Object.entries({ currentTime: 'time', readyState: 'ready', seeking: 'seeking', ended: 'ended', duration: 'duration' })) {
    jest.spyOn(HTMLMediaElement.prototype, name, 'get').mockImplementation(() => media[key]);
  }
  jest.spyOn(HTMLMediaElement.prototype, 'buffered', 'get').mockImplementation(() => {
    const ranges = media.ranges;
    return { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] };
  });
  jest.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(() => { throw new Error('Diagnostics must not seek'); });
  jest.spyOn(HTMLMediaElement.prototype, 'playbackRate', 'set').mockImplementation(() => { throw new Error('Diagnostics must not change rate'); });
  for (const method of ['play', 'pause', 'load']) jest.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => { throw new Error(`Diagnostics must not ${method}`); });
  video = document.createElement('video');
  Object.defineProperty(video, 'error', { get: () => media.error });
  videoRef = { current: video };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  props = { videoRef, clip, time: 6000, playing: true, attempt: 0 };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); localStorage.clear(); jest.restoreAllMocks(); jest.useRealTimers();
});

test('reports continuous playable seconds ahead, not the sum or last end of disjoint ranges', async () => {
  await render();
  expect(status().textContent).toContain('Buffered ahead: 4.0 s');
  await event('progress', { ranges: [[0, 9], [20, 30]] });
  expect(status().textContent).toContain('Buffered ahead: 4.0 s');
  await event('progress', { time: 15 });
  expect(status().textContent).toContain('Buffered ahead: 0.0 s');
  await event('progress', { time: 22 });
  expect(status().textContent).toContain('Buffered ahead: 8.0 s');
  await event('progress', { time: 30 });
  expect(status().textContent).toContain('Buffered ahead: 0.0 s');
});

test('distinguishes metadata loading from an empty buffer and updates on progress while paused', async () => {
  await render({ playing: false });
  await event('emptied', { ready: 0, ranges: [] });
  expect(status().textContent).toContain('Buffered ahead: — s');
  expect(status().textContent).toContain('Audio offset: —');
  expect(status().dataset.state).toBe('loading');
  await event('loadedmetadata', { ready: 1 });
  expect(status().textContent).toContain('Buffered ahead: 0.0 s');
  expect(status().dataset.state).toBe('paused');
  await event('progress', { ranges: [[0, 11]] });
  expect(status().textContent).toContain('Buffered ahead: 6.0 s');
});

test('uses the raw container clock and shows audio delay, lead, and approximate alignment', async () => {
  media.time = 605; media.duration = 630; media.ranges = [[600, 609]];
  await render({ clip: { ...clip, start_pts: 600 }, time: 8000 });
  expect(status().textContent).toContain('Buffered ahead: 4.0 s');
  expect(status().textContent).toContain('2.0 s behind audio');
  await render({ time: 4000 }); await act(async () => jest.advanceTimersByTime(500));
  expect(status().textContent).toContain('2.0 s ahead of audio');
  await render({ time: 6000 }); await act(async () => jest.advanceTimersByTime(500));
  expect(status().textContent).toContain('Audio offset: about 0 s');
});

test('distinguishes video-data waiting, a pending seek, recovery, and ended playback', async () => {
  await render();
  expect(status().dataset.state).toBe('playing');
  await event('waiting', { ready: 2 });
  expect(status().dataset.state).toBe('waiting');
  await event('seeking', { seeking: true });
  expect(status().dataset.state).toBe('seeking');
  await event('seeked', { seeking: false });
  expect(status().dataset.state).toBe('waiting');
  await event('canplay', { ready: 3 });
  expect(status().dataset.state).toBe('playing');
  // A stalled network request is not itself evidence of empty playback buffers.
  await event('stalled');
  await act(async () => jest.advanceTimersByTime(500));
  expect(status().dataset.state).toBe('playing');
  await event('ended', { ended: true });
  expect(status().dataset.state).toBe('ended');
});

test('supports unknown duration, checks readiness without a waiting event, and refreshes at 500 ms', async () => {
  media.duration = Infinity;
  await render();
  media.time = 6; media.ready = 2;
  await act(async () => jest.advanceTimersByTime(499));
  expect(status().textContent).toContain('Buffered ahead: 4.0 s');
  await act(async () => jest.advanceTimersByTime(1));
  expect(status().textContent).toContain('Buffered ahead: 3.0 s');
  expect(status().dataset.state).toBe('waiting');
});

test('changing the source or retrying discards stale waiting status and cleans up listeners and timers', async () => {
  await render(); await event('waiting');
  const old = video;
  const removed = jest.spyOn(old, 'removeEventListener');
  video = document.createElement('video'); videoRef.current = video;
  media.ready = 4; media.ranges = [[0, 15]];
  await render({ clip: { ...clip, url: '/other.webm' } });
  expect(status().dataset.state).toBe('playing');
  expect(status().textContent).toContain('Buffered ahead: 10.0 s');
  expect(removed).toHaveBeenCalledWith('progress', expect.any(Function));
  expect(jest.getTimerCount()).toBe(1);
  await event('waiting'); await render({ attempt: 1 });
  expect(status().dataset.state).toBe('playing');
  expect(jest.getTimerCount()).toBe(1);
  await act(async () => root.unmount());
  expect(jest.getTimerCount()).toBe(0);
  root = createRoot(container);
});

test('samples only media state without mutating playback or making live announcements every tick', async () => {
  await render(); await event('waiting');
  await act(async () => jest.advanceTimersByTime(2000));
  for (const method of ['play', 'pause', 'load']) expect(HTMLMediaElement.prototype[method]).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-live], [role="status"]')).toBeNull();
});
