import { releaseCompleteSelection } from './SelectionMarkers';

test('releasing a complete range retains even a zero-valued start and leaves incomplete endpoints alone', () => {
  expect(releaseCompleteSelection({ start_ms: 0, end_ms: 1000 })).toEqual({ start_ms: 0, end_ms: null });
  for (const selection of [{ start_ms: null, end_ms: null }, { start_ms: 0, end_ms: null },
    { start_ms: null, end_ms: 1000 }, { start_ms: 0, end_ms: 0 }, { start_ms: 2000, end_ms: 1000 }]) {
    expect(releaseCompleteSelection(selection)).toBe(selection);
  }
});
