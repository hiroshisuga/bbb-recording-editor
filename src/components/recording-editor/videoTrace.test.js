import { createVideoTrace } from './videoTrace';

let video, current, trace, media;
const records = () => window.bbbEditorVideoLogs || [];
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  current = { clip: { kind: 'deskshare', relative: 'deskshare/test.webm', start_ms: 1000, start_pts: 600 },
    time: 11000, playing: true, rate: 1, seekVersion: 0, waiting: false, correctionAfter: 0, autoSeekInFlight: false };
  media = { time: 605, ranges: [[600, 608], [620, 630]], ready: 3, seeking: false };
  video = document.createElement('video');
  Object.defineProperties(video, {
    currentTime: { get: () => media.time, set: () => { throw new Error('Trace cannot seek'); } },
    duration: { value: 630 }, readyState: { get: () => media.ready }, seeking: { get: () => media.seeking },
    buffered: { get: () => ({ length: media.ranges.length, start: i => media.ranges[i][0], end: i => media.ranges[i][1] }) },
  });
  video.play = jest.fn(); video.pause = jest.fn(); video.load = jest.fn();
});
afterEach(() => {
  trace?.close(); trace = null;
  delete window.bbbEditorVideoDebug; delete window.bbbEditorVideoLogs;
  jest.restoreAllMocks(); jest.useRealTimers();
});

test('is silent until enabled at runtime and takes immutable snapshots of current and target buffers', () => {
  trace = createVideoTrace(video, () => current);
  jest.advanceTimersByTime(1000); video.dispatchEvent(new Event('waiting'));
  expect(console.info).not.toHaveBeenCalled(); expect(records()).toEqual([]);
  window.bbbEditorVideoDebug = true;
  jest.advanceTimersByTime(1000);
  expect(records()[0]).toEqual(expect.objectContaining({ event: 'sample', audioTimeMs: 11000, targetTimeS: 610,
    videoTimeS: 605, driftS: 5, bufferAheadS: 3, targetBufferAheadS: 0, buffered: [[600, 608], [620, 630]] }));
  const serialized = console.info.mock.calls[0][0];
  expect(serialized.startsWith('[BBB video] {')).toBe(true);
  media.time = 610; media.ranges = [[600, 615]];
  expect(JSON.parse(serialized.slice('[BBB video] '.length)).bufferAheadS).toBe(3);
  expect(records()[0].buffered).toEqual([[600, 608], [620, 630]]);
  window.bbbEditorVideoDebug = false;
  const count = records().length;
  jest.advanceTimersByTime(1000); video.dispatchEvent(new Event('seeking'));
  expect(records()).toHaveLength(count);
});

test('correlates automatic seek requests, post-assignment buffers, and later media events', () => {
  window.bbbEditorVideoDebug = true; trace = createVideoTrace(video, () => current);
  trace.log('seek-request', { reason: 'automatic-drift', toS: 610 });
  media.time = 610; media.seeking = true; media.ready = 1;
  trace.log('seek-assigned', { reason: 'automatic-drift', toS: 610 });
  jest.advanceTimersByTime(5000); media.seeking = false;
  video.dispatchEvent(new Event('seeked'));
  const request = records().find(r => r.event === 'seek-request');
  const assigned = records().find(r => r.event === 'seek-assigned');
  const done = records().find(r => r.event === 'media:seeked');
  expect(request.bufferAheadS).toBe(3); expect(request.targetBufferAheadS).toBe(0);
  expect(assigned.bufferAheadS).toBe(0); expect(assigned.seeking).toBe(true);
  expect(done.seekNumber).toBe(request.seekNumber); expect(done.seekReason).toBe('automatic-drift');
  expect(done.sinceSeekRequestMs).toBe(5000);
});

test('captures actual presented frame time when supported and cancels its callback when disabled or closed', () => {
  let callback, nextId = 0;
  video.requestVideoFrameCallback = jest.fn(fn => { callback = fn; return ++nextId; });
  video.cancelVideoFrameCallback = jest.fn();
  window.bbbEditorVideoDebug = true; trace = createVideoTrace(video, () => current);
  expect(records()[0].lastFrameTimeS).toBeNull();
  callback(performance.now(), { mediaTime: 604.8 });
  jest.advanceTimersByTime(1000);
  expect(records().at(-1)).toEqual(expect.objectContaining({ lastFrameTimeS: 604.8, frameDriftS: 5.2, frameAgeMs: 1000 }));
  window.bbbEditorVideoDebug = false; jest.advanceTimersByTime(1000);
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledTimes(1);
  window.bbbEditorVideoDebug = true; jest.advanceTimersByTime(1000);
  expect(records().at(-1).lastFrameTimeS).toBeNull();
  trace.close(); expect(video.cancelVideoFrameCallback).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
  const count = records().length;
  video.dispatchEvent(new Event('waiting')); expect(records()).toHaveLength(count);
  trace = null;
});

test('limits retained records, tolerates console failures, and never mutates playback', () => {
  window.bbbEditorVideoDebug = true; trace = createVideoTrace(video, () => current);
  for (let i = 0; i < 650; i++) trace.log('sample');
  expect(records()).toHaveLength(600);
  console.info.mockImplementation(() => { throw new Error('Console unavailable'); });
  expect(() => trace.log('sample')).not.toThrow();
  expect(media.time).toBe(605);
  for (const name of ['play', 'pause', 'load']) expect(video[name]).not.toHaveBeenCalled();
});

test('camera previews create no trace timer or logs', () => {
  current.clip.kind = 'video'; window.bbbEditorVideoDebug = true;
  trace = createVideoTrace(video, () => current);
  trace.log('seek-request'); video.dispatchEvent(new Event('waiting'));
  jest.advanceTimersByTime(1000);
  expect(jest.getTimerCount()).toBe(0); expect(console.info).not.toHaveBeenCalled();
});
