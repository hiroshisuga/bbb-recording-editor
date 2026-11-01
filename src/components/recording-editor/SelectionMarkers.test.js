import { releaseCompleteSelection } from './SelectionMarkers';

test.each([
  [5000, { start_ms: null, end_ms: 20000 }],
  [10000, { start_ms: null, end_ms: 20000 }],
  [12000, { start_ms: null, end_ms: 20000 }],
  [14999, { start_ms: null, end_ms: 20000 }],
  [15000, { start_ms: 10000, end_ms: null }],
  [18000, { start_ms: 10000, end_ms: null }],
  [20000, { start_ms: 10000, end_ms: null }],
  [25000, { start_ms: 10000, end_ms: null }],
])('click at %s releases the nearer endpoint of a completed range', (position, expected) => {
  const selection = { start_ms: 10000, end_ms: 20000 };
  expect(releaseCompleteSelection(selection, position)).toEqual(expected);
  expect(selection).toEqual({ start_ms: 10000, end_ms: 20000 });
});

test('zero-valued starts survive right-side clicks; incomplete endpoints and invalid positions are untouched', () => {
  expect(releaseCompleteSelection({ start_ms: 0, end_ms: 1000 }, 500)).toEqual({ start_ms: 0, end_ms: null });
  for (const selection of [{ start_ms: null, end_ms: null }, { start_ms: 0, end_ms: null },
    { start_ms: null, end_ms: 1000 }, { start_ms: 0, end_ms: 0 }, { start_ms: 2000, end_ms: 1000 }]) {
    expect(releaseCompleteSelection(selection, 500)).toBe(selection);
  }
  const complete = { start_ms: 1000, end_ms: 2000 };
  expect(releaseCompleteSelection(complete, NaN)).toBe(complete);
});
