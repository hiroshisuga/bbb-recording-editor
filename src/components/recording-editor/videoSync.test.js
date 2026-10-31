import { synchronizationRate } from './videoSync';

// The previous controller is a reference for recovery time, not a second
// implementation of the adaptive policy under test.
function previousRate(rate, drift, ahead) {
  if (Math.abs(drift) <= 0.15) return rate;
  const change = Math.min(drift > 0 ? 1 : 0.5, Math.ceil(Math.abs(drift) * 4) * 0.05);
  let result = rate * (1 + (drift > 0 ? change : -change));
  if (drift > 0) result = Math.min(result, Math.max(rate, Math.floor(ahead / 2 * 20) / 20));
  return Math.max(0.25, Math.min(4, result));
}

function recover(policy, lag, buffer, supply, base = 1) {
  let video = 0, audio = lag, end = buffer, elapsed = 0, minimum = buffer, maxRate = base;
  while (audio - video > 0.15 && elapsed < 120) {
    const ahead = end - video;
    const rate = policy(base, audio - video, ahead);
    if (rate > base) expect(ahead / rate).toBeGreaterThanOrEqual(2 - 1e-8);
    expect(rate).toBeLessThanOrEqual(4);
    maxRate = Math.max(maxRate, rate);
    video += rate * 0.1;
    audio += base * 0.1;
    end += supply * 0.1;
    minimum = Math.min(minimum, end - video);
    elapsed += 0.1;
  }
  return { elapsed, minimum, maxRate, drift: audio - video };
}

test.each([1, 2])('ample buffers shorten recovery for a small backlog at %sx without draining the reserve', base => {
  const before = recover(previousRate, 3, 60, base, base);
  const after = recover(synchronizationRate, 3, 60, base, base);
  expect(after.elapsed).toBeLessThan(before.elapsed * 0.6);
  expect(after.drift).toBeLessThanOrEqual(0.15);
  expect(after.minimum).toBeGreaterThan(50);
});

test('limited supply retains the conservative controller response without buffer starvation', () => {
  const before = recover(previousRate, 8, 3, 1.25);
  const after = recover(synchronizationRate, 8, 3, 1.25);
  expect(after.elapsed).toBeCloseTo(before.elapsed);
  expect(after.minimum).toBeGreaterThan(1.9);
  expect(after.drift).toBeLessThanOrEqual(0.15);
});

test('remaining buffer controls acceleration, with base-speed fallback and bounded slowing for ahead video', () => {
  expect(synchronizationRate(1, 8, 60)).toBe(3);
  expect(synchronizationRate(1, 8, 5)).toBe(2);
  expect(synchronizationRate(1, 8, 3)).toBe(1.5);
  expect(synchronizationRate(1, 8, 2)).toBe(1);
  expect(synchronizationRate(1, 8, 0)).toBe(1);
  expect(synchronizationRate(1, -8, 60)).toBe(0.5);
  expect(synchronizationRate(0.5, -8, 60)).toBe(0.25);
  expect(synchronizationRate(2, 8, 60)).toBe(4);
  expect(synchronizationRate(1, 0.1, 60)).toBe(1);
});
