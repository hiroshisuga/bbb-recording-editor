import { DEFAULT_PREFERENCES, PREFERENCES_KEY, readPreferences } from './preferences';

beforeEach(() => localStorage.removeItem(PREFERENCES_KEY));
afterEach(() => { jest.restoreAllMocks(); localStorage.removeItem(PREFERENCES_KEY); });

test.each([null, '{invalid', 'null', '[]', '{"version":2,"volume":0.2}'])('missing or unsupported preferences fall back safely: %s', saved => {
  if (saved !== null) localStorage.setItem(PREFERENCES_KEY, saved);
  expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
});

test('valid preferences are restored without importing unrelated recording data', () => {
  const values = { ...DEFAULT_PREFERENCES, volume: 0.35, muted: true, lastVolume: 0.35, beepPreview: false, rate: 1.5, zoom: 8, detailWaveOpen: true, detailWaveSpan: 5000 };
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ version: 1, ...values, recordingId: 'not-a-preference' }));
  expect(readPreferences()).toEqual(values);
});

test('invalid fields fall back independently and do not reach media controls', () => {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ version: 1, volume: 20, muted: 'false', lastVolume: -1,
    beepPreview: false, rate: 100, zoom: 3, detailWaveOpen: 'yes', detailWaveSpan: 1 }));
  expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES, beepPreview: false });
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ version: 1, volume: 0.4, muted: true,
    beepPreview: 'false', rate: '1.5', zoom: 4 }));
  expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES, volume: 0.4, lastVolume: 0.4, muted: true, zoom: 4 });
});

test('storage access restrictions use defaults', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
});
