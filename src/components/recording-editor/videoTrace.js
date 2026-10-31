// Opt-in, read-only diagnostics. Keep console entries as serialized snapshots:
// DevTools can otherwise show an object's later values when it is expanded.
let nextTraceId = 0;
const EVENTS = ['loadedmetadata', 'loadeddata', 'progress', 'waiting', 'playing', 'canplay', 'seeking', 'seeked', 'stalled', 'emptied', 'pause', 'play', 'ratechange', 'ended', 'error'];
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;

export function createVideoTrace(video, getCurrent) {
  if (getCurrent().clip?.kind !== 'deskshare') return { log: () => {}, close: () => {} };
  const traceId = ++nextTraceId;
  const startedAt = performance.now();
  let alive = true;
  let frameRequest = null;
  let frameTime = null;
  let frameAt = null;
  let seekNumber = 0;
  let seekReason = null;
  let seekAt = null;
  const enabled = () => alive && window.bbbEditorVideoDebug === true;
  const stopFrames = () => {
    if (frameRequest !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameRequest);
    frameRequest = null;
    frameTime = null;
    frameAt = null;
  };
  const frame = (now, metadata) => {
    frameRequest = null;
    if (!enabled()) { stopFrames(); return; }
    frameTime = metadata.mediaTime;
    frameAt = now;
    frameRequest = video.requestVideoFrameCallback(frame);
  };
  const log = (event, extra = {}) => {
    if (!enabled()) { stopFrames(); return; }
    // A diagnostic failure must never interrupt media synchronization.
    try {
      if (frameRequest === null && video.requestVideoFrameCallback) frameRequest = video.requestVideoFrameCallback(frame);
      const current = getCurrent();
      const now = performance.now();
      if (event === 'seek-request') { seekNumber++; seekReason = extra.reason; seekAt = now; }
      const origin = Math.max(0, Number(current.clip.start_pts) || 0);
      let target = origin + Math.max(0, (current.time - current.clip.start_ms) / 1000);
      if (Number.isFinite(video.duration) && video.duration >= origin) target = Math.min(target, Math.max(origin, video.duration - 0.001));
      const buffered = video.buffered;
      const ranges = Array.from({ length: buffered.length }, (_, i) => [buffered.start(i), buffered.end(i)]);
      const ahead = position => {
        const range = ranges.find(([start, end]) => start <= position && position <= end);
        return range ? Math.max(0, range[1] - position) : 0;
      };
      const quality = video.getVideoPlaybackQuality?.();
      const row = {
        traceId, event, seekNumber, seekReason, sinceSeekRequestMs: seekAt === null ? null : round(now - seekAt), at: new Date().toISOString(), elapsedMs: round(now - startedAt),
        file: current.clip.relative, audioTimeMs: round(current.time), originS: origin,
        targetTimeS: round(target), videoTimeS: round(video.currentTime),
        driftS: round(target - video.currentTime), bufferAheadS: round(ahead(video.currentTime)),
        targetBufferAheadS: round(ahead(target)), buffered: ranges.map(range => range.map(round)),
        lastFrameTimeS: round(frameTime), frameDriftS: frameTime === null ? null : round(target - frameTime),
        frameAgeMs: frameAt === null ? null : round(now - frameAt),
        readyState: video.readyState, networkState: video.networkState,
        seeking: video.seeking, paused: video.paused, requestedPlaying: current.playing,
        requestedRate: current.rate, playbackRate: video.playbackRate, seekVersion: current.seekVersion,
        waiting: current.waiting, correctionWaitMs: round(Math.max(0, current.correctionAfter - now)),
        autoSeekInFlight: current.autoSeekInFlight, syncPolicy: current.syncPolicy ?? null,
        totalFrames: quality?.totalVideoFrames ?? null, droppedFrames: quality?.droppedVideoFrames ?? null,
        ...extra,
      };
      if (!Array.isArray(window.bbbEditorVideoLogs)) window.bbbEditorVideoLogs = [];
      window.bbbEditorVideoLogs.push(row);
      if (window.bbbEditorVideoLogs.length > 600) window.bbbEditorVideoLogs.splice(0, window.bbbEditorVideoLogs.length - 600);
      console.info(`[BBB video] ${JSON.stringify(row)}`);
    } catch { /* Diagnostics are optional; media playback must continue. */ }
  };
  const mediaEvent = event => log(`media:${event.type}`);
  EVENTS.forEach(name => video.addEventListener(name, mediaEvent));
  const timer = setInterval(() => log('sample'), 1000);
  log('mount');
  return {
    log,
    close: () => {
      log('unmount');
      alive = false;
      clearInterval(timer);
      EVENTS.forEach(name => video.removeEventListener(name, mediaEvent));
      stopFrames();
    },
  };
}
