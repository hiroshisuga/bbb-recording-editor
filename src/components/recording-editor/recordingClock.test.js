import { recordingClock } from './recordingClock';
import fixtures from './__fixtures__/recording-clock.json';

test.each(fixtures)('effective clock matches server fixture: $name', fixture => {
  const clock = recordingClock(fixture.records, fixture.gaps, fixture.duration);
  expect(clock.ranges.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }))).toEqual(fixture.effective);
  expect(clock.total).toBe(fixture.total);
});

test('removed prefix, gaps, suffix, and exact interval endpoints have explicit meanings', () => {
  const f = fixtures[0], clock = recordingClock(f.records, f.gaps, f.duration);
  for (const [source, time, included] of [[0, 0, false], [10000, 0, true], [19999, 9999, true],
    [20000, 10000, false], [25000, 10000, false], [30000, 10000, true], [35000, 15000, true],
    [40000, 20000, true], [45000, 20000, false]]) {
    expect(clock.at(source)).toEqual({ time, included, empty: false });
  }
});

test('both halves of a cue count toward edited time, including the cue join', () => {
  const f = fixtures[1], clock = recordingClock(f.records, f.gaps, f.duration);
  expect(clock.at(20000)).toMatchObject({ time: 10000, included: true });
  expect(clock.at(20125)).toMatchObject({ time: 10125, included: false });
  expect(clock.at(25000)).toMatchObject({ time: 10125, included: false });
  expect(clock.at(29875)).toMatchObject({ time: 10125, included: true });
  expect(clock.at(35000)).toMatchObject({ time: 15250, included: true });
});

test('no intervals, a full meeting, overlapping ranges, and stale chime selections', () => {
  expect(recordingClock([], [], 50000).at(25000)).toEqual({ time: 0, included: false, empty: true });
  const clock = recordingClock([{ start_ms: 0, end_ms: 50000 }], [], 50000);
  expect(clock.at(50000)).toEqual({ time: 50000, included: true, empty: false });
  expect(clock.at(12345).time).toBe(12345);
  expect(recordingClock([{ start_ms: 0, end_ms: 20000 }, { start_ms: 10000, end_ms: 60000 }], [], 50000).total).toBe(50000);
  expect(recordingClock(fixtures[0].records, [{ start_ms: 1000, end_ms: 5000 }], 50000).total).toBe(20000);
});
