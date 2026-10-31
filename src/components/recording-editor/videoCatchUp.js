import { synchronizationRate } from './videoSync';

const STEPS = [0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12];
const WINDOW_MS = 2000;
const RETRY_MS = 30000;

// Only the muted video is controlled. No audio element, seek, or media fetch is
// needed: keep two frame timestamps per observation window, not decoded images.
export function createVideoCatchUp(video, report = () => {}) {
  let supported = typeof video.requestVideoFrameCallback === 'function'
    && typeof video.cancelVideoFrameCallback === 'function';
  let alive = true, frameRequest = null, generation = 0;
  let base = null, normalRate = 1, active = false, window = null, good = [], pending = null;
  let last = null, reason = 'idle', waitingAt = null, waitMs = 0;
  let retryAfter = 0, retryCeiling = Infinity, supportedCeiling = 12;
  let measuredCeiling = null, finishing = false;
  const emit = (event, values) => report(event, values);
  const stopFrames = () => {
    generation++;
    if (frameRequest !== null) video.cancelVideoFrameCallback(frameRequest);
    frameRequest = null;
  };
  const observe = () => {
    const token = generation;
    const frame = (now, metadata) => {
      if (!alive || !active || token !== generation) return;
      frameRequest = null;
      if (window && now >= window.at + 250 && Number.isFinite(metadata.mediaTime)) {
        const point = { at: now, time: metadata.mediaTime };
        if (!window.first) window.first = point;
        window.last = point;
      }
      frameRequest = video.requestVideoFrameCallback(frame);
    };
    try { frameRequest = video.requestVideoFrameCallback(frame); }
    catch { supported = false; active = false; reason = 'frame-api-unavailable'; }
  };
  const stop = why => {
    if (active) emit('catch-up-stop', { reason: why });
    active = false; window = null; good = []; pending = null; last = null;
    waitingAt = null; waitMs = 0; reason = why;
    if (why === 'tail') finishing = true;
    stopFrames();
  };
  const reset = () => {
    stop('reset'); retryAfter = 0; retryCeiling = Infinity; measuredCeiling = null; finishing = false;
  };
  const waiting = now => {
    measuredCeiling = null;
    finishing = false;
    if (active && waitingAt === null) waitingAt = now;
  };
  const ready = now => {
    if (waitingAt !== null) { waitMs += Math.max(0, now - waitingAt); waitingAt = null; }
  };
  const begin = (now, drift, rate) => {
    window = { at: now, time: video.currentTime, drift, rate, first: null, last: null };
    waitMs = 0;
    if (waitingAt !== null) waitingAt = now;
  };
  const backoff = (now, why) => {
    // A failed probe was never added to good. A failing held speed steps down.
    if (!pending && good.length > 1) good.pop();
    pending = null;
    retryCeiling = good.at(-1)?.rate ?? (why === 'insufficient-frames' ? normalRate : base);
    retryAfter = now + RETRY_MS;
    measuredCeiling = good.at(-1)?.rate ?? null;
    reason = why;
    emit('catch-up-backoff', { reason: why, ceiling: retryCeiling, retryMs: RETRY_MS, ...last });
    window = null;
  };
  const update = ({ now, rate, drift, ahead, blocked = false, visible = true }) => {
    if (rate !== base) { reset(); base = rate; }
    const fallbackCeiling = Math.min(supportedCeiling, now < retryAfter ? Math.max(rate, retryCeiling) : Infinity);
    const fallback = Math.min(fallbackCeiling, synchronizationRate(rate, drift, ahead, measuredCeiling));
    normalRate = fallback;
    if (Math.abs(drift) <= 0.15) finishing = false;
    if (!alive || !supported) return blocked ? rate : fallback;
    if (!visible || drift <= 0.5) {
      if (active) stop(!visible ? 'hidden' : 'tail');
      if (!visible) measuredCeiling = null;
      return blocked ? rate : !visible ? Math.min(fallbackCeiling, synchronizationRate(rate, drift, ahead)) : fallback;
    }
    if (blocked) {
      waiting(now);
      if (active && window && waitMs + now - waitingAt > 200) {
        backoff(now, 'waiting'); stop('waiting'); measuredCeiling = null;
      }
      return rate;
    }
    ready(now);
    if (!active) {
      if (drift < 3 || (finishing && drift < 8) ||
        (now < retryAfter && retryCeiling <= fallback) || supportedCeiling <= fallback) return fallback;
      active = true; good = []; pending = null; reason = 'baseline';
      begin(now, drift, fallback); observe();
      if (!active) return fallback;
      emit('catch-up-step', { reason, rate: fallback });
    }
    let selected = pending ?? good.at(-1)?.rate ?? fallback;
    // buffered is advisory: a two-second parsed queue can hide tens of seconds
    // of received data. Readiness/waiting and actual progress govern the probe.
    // Leave the last seconds to the existing fine correction. Never cross the
    // master position by keeping a large rate until the next observation window.
    const approachLimit = rate + Math.max(0, drift - 1) / 0.5;
    if (selected > approachLimit) { stop('tail'); return fallback; }
    if (!window) begin(now, drift, selected);
    const elapsedMs = now - window.at;
    if (elapsedMs >= WINDOW_MS) {
      if (elapsedMs > 4000) { stop('observation-gap'); return fallback; }
      const seconds = elapsedMs / 1000;
      const frames = window.first && window.last && window.last.at - window.first.at >= 500;
      if (!frames) {
        // Static / variable-FPS screen sharing may legitimately emit no frames.
        // Missing evidence prevents a faster probe; it is not a decoder failure.
        if (elapsedMs < 3500) return selected;
        backoff(now, 'insufficient-frames');
        if (!good.length) { stop('insufficient-frames'); return fallback; }
      } else {
        last = {
          observedVideoRate: (video.currentTime - window.time) / seconds,
          observedFrameRate: (window.last.time - window.first.time) / ((window.last.at - window.first.at) / 1000),
          lagRecoveryRate: (window.drift - drift) / seconds,
          waitingFraction: waitMs / elapsedMs,
        };
        const effective = Math.min(last.observedVideoRate, last.observedFrameRate);
        const previous = good.at(-1);
        const recovering = window.rate <= rate + 0.05 || last.lagRecoveryRate > 0.1;
        const healthy = effective >= window.rate * 0.7 && recovering && last.waitingFraction < 0.1;
        const improves = !previous || (effective > previous.effective * 1.08 && last.lagRecoveryRate > previous.recovery + 0.15);
        if (!healthy || (pending !== null && !improves)) {
          backoff(now, !healthy ? 'slow-progress' : 'no-improvement');
          if (last.waitingFraction >= 0.1) {
            stop('waiting'); measuredCeiling = null;
            return Math.min(supportedCeiling, Math.max(rate, retryCeiling), synchronizationRate(rate, drift, ahead));
          }
          if (!good.length) { stop('slow-progress'); return Math.min(fallback, rate); }
        } else {
          const measured = { rate: window.rate, effective, recovery: last.lagRecoveryRate };
          if (pending !== null || !good.length) good.push(measured);
          else good[good.length - 1] = measured;
          measuredCeiling = measured.rate;
          pending = null;
          const ceiling = Math.min(supportedCeiling, now < retryAfter ? retryCeiling : 12);
          const next = STEPS.find(step => step > window.rate + 0.01 && step <= ceiling);
          if (next && next <= approachLimit) {
            pending = next; reason = 'probe';
            emit('catch-up-step', { reason, rate: next, ...last });
          } else reason = 'hold';
          window = null;
        }
      }
      selected = pending ?? good.at(-1)?.rate ?? fallback;
      begin(now, drift, selected);
    }
    return selected;
  };
  return {
    update, reset, waiting, ready,
    rejectRate(rate, accepted, now) {
      supportedCeiling = Math.min(supportedCeiling, accepted);
      good = good.filter(point => point.rate <= accepted);
      backoff(now, 'unsupported-rate');
      emit('catch-up-rate-rejected', { requestedRate: rate, acceptedRate: accepted });
      return Math.min(accepted, normalRate);
    },
    snapshot(now) {
      return { catchUpPhase: active ? (pending !== null ? 'probe' : good.length ? 'hold' : 'baseline') : 'idle',
        catchUpReason: reason, catchUpRate: active ? (pending ?? good.at(-1)?.rate ?? window?.rate) : null,
        catchUpRetryMs: Math.max(0, retryAfter - now), measuredRateCeiling: measuredCeiling, ...last };
    },
    close() { stop('closed'); alive = false; },
  };
}
