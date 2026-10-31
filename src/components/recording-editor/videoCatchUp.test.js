import { createVideoCatchUp } from './videoCatchUp';

function simulation({ base = 1, lag = 60, clockSpeed = rate => rate, frameSpeed = clockSpeed, frames = true } = {}) {
  let now = 0, master = 20 + lag, frameTime = 20, selected = base, callback = null, nextId = 0;
  let framesEnabled = frames;
  const video = { currentTime: 20,
    requestVideoFrameCallback: jest.fn(fn => { callback = fn; return ++nextId; }),
    cancelVideoFrameCallback: jest.fn(() => { callback = null; }),
  };
  const events = [];
  const controller = createVideoCatchUp(video, (event, values) => events.push({ at: now, event, ...values }));
  let overrides = {};
  const update = changes => {
    overrides = { ...overrides, ...changes };
    selected = controller.update({ now, rate: base, drift: master - video.currentTime, ahead: 1000, ...overrides });
    return selected;
  };
  const advance = (ms, changes = {}) => {
    const target = now + ms;
    while (now < target) {
      const seconds = Math.min(100, target - now) / 1000;
      now += seconds * 1000;
      master += base * seconds;
      video.currentTime += clockSpeed(selected) * seconds;
      frameTime += frameSpeed(selected) * seconds;
      if (callback && framesEnabled) { const fn = callback; callback = null; fn(now, { mediaTime: frameTime }); }
      update(changes);
    }
  };
  update();
  return { video, controller, events, advance, update, now: () => now, rate: () => selected,
    setLag: lag => { master = video.currentTime + lag; }, setFrames: enabled => { framesEnabled = enabled; },
    drift: () => master - video.currentTime, hasCallback: () => callback !== null, callback: () => callback };
}

test.each([1, 2])('measured staged catch-up converges without crossing the master at %sx', base => {
  const s = simulation({ base });
  let maximum = 0;
  while (s.now() < 20000 && s.drift() > 0.15) {
    s.advance(100); maximum = Math.max(maximum, s.rate());
    expect(s.drift()).toBeGreaterThan(-0.15);
  }
  expect(s.now()).toBeLessThan(20000);
  expect(maximum).toBe(12);
  expect(s.rate()).toBe(base);
  const steps = s.events.filter(event => event.event === 'catch-up-step').map(event => event.rate);
  expect(steps).toEqual(base === 1 ? [3, 4, 6, 8, 12] : [4, 6, 8, 12]);
  expect(s.hasCallback()).toBe(false);
  s.controller.close();
});

test('an ineffective 12x probe returns to measured 8x and prevents another probe for 30 seconds', () => {
  const s = simulation({ lag: 500, clockSpeed: rate => rate === 12 ? 7 : rate });
  s.advance(10000);
  const backoff = s.events.find(event => event.event === 'catch-up-backoff');
  expect(backoff).toEqual(expect.objectContaining({ reason: 'slow-progress', ceiling: 8, retryMs: 30000 }));
  expect(s.rate()).toBe(8);
  s.advance(29000);
  expect(s.events.filter(event => event.event === 'catch-up-step' && event.rate === 12)).toHaveLength(1);
  s.advance(3000);
  expect(s.events.filter(event => event.event === 'catch-up-step' && event.rate === 12)).toHaveLength(2);
  s.controller.close();
});

test('an advancing internal clock cannot approve a probe whose displayed frames fail to improve', () => {
  const s = simulation({ lag: 500, frameSpeed: rate => rate >= 6 ? 4.3 : rate });
  s.advance(6000);
  expect(s.events).toContainEqual(expect.objectContaining({ event: 'catch-up-backoff', reason: 'no-improvement', ceiling: 4 }));
  expect(s.rate()).toBe(4);
  expect(s.controller.snapshot(s.now()).observedVideoRate).toBeCloseTo(6);
  expect(s.controller.snapshot(s.now()).observedFrameRate).toBeCloseTo(4.3);
  s.controller.close();
});

test('short reported ranges alone do not cancel healthy measured progress', () => {
  const s = simulation({ lag: 500 }); s.advance(6000);
  expect(s.rate()).toBe(8);
  expect(s.update({ ahead: 2 })).toBe(8);
  expect(s.hasCallback()).toBe(true);
  s.advance(2000);
  expect(s.rate()).toBe(12);
  s.controller.close();
});

test('waiting returns to master speed immediately and sustained waiting backs off once', () => {
  const s = simulation({ lag: 500 }); s.advance(6000);
  s.controller.waiting(s.now());
  expect(s.update({ blocked: true })).toBe(1);
  s.advance(1000, { blocked: true });
  expect(s.events.filter(event => event.event === 'catch-up-backoff' && event.reason === 'waiting')).toHaveLength(1);
  s.controller.ready(s.now());
  expect(s.update({ blocked: false })).toBe(3);
  expect(s.controller.snapshot(s.now()).catchUpRetryMs).toBeGreaterThan(29000);
  s.advance(2000); expect(s.rate()).toBe(4);
  s.advance(2000); expect(s.rate()).toBe(6);
  s.controller.close();
});

function briefWait(s, ms = 11, base = 1) {
  s.controller.waiting(s.now());
  expect(s.update({ blocked: true })).toBe(base);
  s.advance(ms, { blocked: true });
  s.controller.ready(s.now());
  s.update({ blocked: false, ahead: 2.5 });
}

test('a brief wait revalidates at ordinary speed before restoring history even below three seconds of lag', () => {
  const s = simulation(); s.advance(2000);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBe(3);
  s.setLag(2.4);
  briefWait(s);
  expect(s.rate()).toBe(1.25);
  expect(s.controller.snapshot(s.now())).toEqual(expect.objectContaining({ catchUpReason: 'revalidate', measuredRateCeiling: null }));
  s.advance(1900);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBeNull();
  s.advance(100);
  expect(s.events).toContainEqual(expect.objectContaining({ event: 'catch-up-revalidated', measuredRateCeiling: 3 }));
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBe(3);
  expect(s.rate()).toBeGreaterThan(1.25);
  const start = s.now();
  while (s.drift() > 0.15 && s.now() - start < 5000) { s.advance(100); expect(s.drift()).toBeGreaterThan(-0.15); }
  expect(s.drift()).toBeLessThanOrEqual(0.15);
  expect(s.rate()).toBe(1);
  s.controller.close();
});

test('brief waiting during fine correction also rechecks the retained speed', () => {
  const s = simulation(); s.advance(2000); s.setLag(2);
  s.update();
  expect(s.controller.snapshot(s.now()).catchUpPhase).toBe('idle');
  briefWait(s); s.advance(2000);
  expect(s.events).toContainEqual(expect.objectContaining({ event: 'catch-up-revalidated', measuredRateCeiling: 3 }));
  s.controller.close();
});

test('revalidation can restore history at 2x audio even if ordinary video correction cannot yet close the gap', () => {
  const s = simulation({ base: 2 }); s.advance(2000); s.setLag(4.8);
  briefWait(s, 11, 2);
  expect(s.rate()).toBe(2);
  s.advance(2000);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBe(4);
  expect(s.rate()).toBe(4);
  s.controller.close();
});

test('a long wait invalidates history even when no synchronization tick occurs during the wait', () => {
  const s = simulation(); s.advance(2000); s.setLag(2.4);
  s.controller.waiting(s.now() - 300);
  s.controller.ready(s.now());
  s.update({ ahead: 2.5 }); s.advance(2500);
  expect(s.events.some(event => event.event === 'catch-up-revalidated')).toBe(false);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBeNull();
  expect(s.events).toContainEqual(expect.objectContaining({ event: 'catch-up-backoff', reason: 'waiting' }));
  s.controller.close();
});

test('slow frames after a brief wait cannot restore an earlier successful speed', () => {
  let slow = false;
  const s = simulation({ frameSpeed: rate => slow ? 0.2 : rate });
  s.advance(2000); s.setLag(2.4); slow = true;
  briefWait(s); s.advance(2200);
  expect(s.events.some(event => event.event === 'catch-up-revalidated')).toBe(false);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBeNull();
  expect(s.rate()).toBe(1);
  s.controller.close();
});

test('missing frames cannot restore a retained speed', () => {
  const s = simulation(); s.advance(2000); s.setLag(2.4); s.setFrames(false);
  briefWait(s); s.advance(3600);
  expect(s.events.some(event => event.event === 'catch-up-revalidated')).toBe(false);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).toBeNull();
  expect(s.hasCallback()).toBe(false);
  s.controller.close();
});

test('another wait during revalidation discards the unconfirmed history', () => {
  const s = simulation(); s.advance(2000); s.setLag(2.4);
  briefWait(s); s.advance(300); briefWait(s); s.advance(2500);
  expect(s.events.some(event => event.event === 'catch-up-revalidated')).toBe(false);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).not.toBe(3);
  s.controller.close();
});

test.each(['reset', 'hidden', 'rate'])('%s prevents reusing the brief-wait history', action => {
  const s = simulation(); s.advance(2000); s.setLag(2.4); briefWait(s);
  if (action === 'reset') s.controller.reset();
  else if (action === 'hidden') s.update({ visible: false });
  else s.update({ rate: 2 });
  s.advance(2500);
  expect(s.events.some(event => event.event === 'catch-up-revalidated')).toBe(false);
  expect(s.controller.snapshot(s.now()).measuredRateCeiling).not.toBe(3);
  s.controller.close();
});

test('no new frames is inconclusive, not permission to keep increasing or a decoder failure', () => {
  const s = simulation({ frames: false }); s.advance(3600);
  expect(s.rate()).toBe(3);
  expect(s.hasCallback()).toBe(false);
  expect(s.events.some(event => event.reason === 'insufficient-frames')).toBe(true);
  expect(s.events.some(event => event.reason === 'slow-progress')).toBe(false);
  s.controller.close();
});

test('reset cancels frame observation and old callbacks cannot revive the previous measurement', () => {
  const s = simulation(); s.advance(3000);
  const stale = s.callback();
  s.controller.reset();
  stale(s.now() + 100, { mediaTime: 200 });
  expect(s.hasCallback()).toBe(false);
  expect(s.video.cancelVideoFrameCallback).toHaveBeenCalled();
  expect(s.controller.snapshot(s.now())).toEqual(expect.objectContaining({ catchUpPhase: 'idle', catchUpRate: null }));
  s.controller.close();
});

test('hidden tabs retain normal correction, while visible tabs can observe short reported buffers', () => {
  const s = simulation();
  expect(s.update({ visible: false })).toBe(3);
  expect(s.hasCallback()).toBe(false);
  s.advance(5000);
  expect(s.hasCallback()).toBe(false);
  expect(s.update({ visible: true, ahead: 18 })).toBe(3);
  expect(s.hasCallback()).toBe(true);
  s.controller.close();
});

test.each([1, 2])('small buffered-time reports allow conservative measured steps and convergence at %sx', base => {
  const s = simulation({ base, lag: 60 });
  s.controller.reset(); s.update({ ahead: 2.5 });
  let maximum = base;
  while (s.now() < 35000 && s.drift() > 0.15) {
    s.advance(100); maximum = Math.max(maximum, s.rate());
    expect(s.drift()).toBeGreaterThan(-0.15);
  }
  expect(s.drift()).toBeLessThanOrEqual(0.15);
  expect(maximum).toBeGreaterThan(4);
  expect(s.now()).toBeLessThan(35000);
  const steps = s.events.filter(event => event.event === 'catch-up-step').map(event => event.rate);
  if (base === 1) expect(steps.slice(1, 5)).toEqual([1.25, 1.5, 2, 3]);
  else expect(steps.slice(1, 3)).toEqual([2, 3]);
  s.controller.close();
});

test('a zero reported range cannot permanently prevent probing when base-rate frames are actually progressing', () => {
  const s = simulation({ lag: 500 });
  s.controller.reset(); s.update({ ahead: 0 }); s.advance(8000);
  expect(s.rate()).toBe(3);
  s.controller.close();
});

test('actual limited throughput fails a small probe and retains the last effective speed', () => {
  const s = simulation({ lag: 500, clockSpeed: rate => rate > 1.5 ? 1 : rate });
  s.controller.reset(); s.update({ ahead: 2.5 }); s.advance(6500);
  expect(s.rate()).toBe(1.5);
  expect(s.events).toContainEqual(expect.objectContaining({ event: 'catch-up-backoff', ceiling: 1.5 }));
  s.advance(10000);
  expect(s.rate()).toBe(1.5);
  s.controller.close();
});

test('an unhealthy baseline also limits ordinary correction during the cooldown', () => {
  const s = simulation({ lag: 500, clockSpeed: rate => rate > 1.2 ? 1.1 : rate });
  s.advance(12000);
  expect(s.rate()).toBe(1);
  expect(s.events.filter(event => event.event === 'catch-up-step')).toHaveLength(1);
  expect(s.controller.snapshot(s.now()).catchUpRetryMs).toBeGreaterThan(19000);
  s.controller.close();
});

test('browsers without frame callbacks keep the old rate policy and create no observation loop', () => {
  const controller = createVideoCatchUp({ currentTime: 0 });
  expect(controller.update({ now: 1000, rate: 1, drift: 60, ahead: 1000 })).toBe(3);
  expect(controller.update({ now: 1000, rate: 1, drift: 60, ahead: 1 })).toBe(1);
  controller.close();
});

test('unsupported high rates are remembered across a reset and never retried for this source', () => {
  const s = simulation({ lag: 500 }); s.advance(4000);
  expect(s.rate()).toBe(6);
  expect(s.controller.rejectRate(6, 4, s.now())).toBe(3);
  s.controller.reset(); s.update(); s.advance(10000);
  expect(s.rate()).toBe(4);
  expect(s.events.filter(event => event.event === 'catch-up-step' && event.rate === 6)).toHaveLength(1);
  s.controller.close();
});
