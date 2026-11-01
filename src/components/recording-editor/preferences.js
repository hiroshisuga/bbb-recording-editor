import { useEffect, useState } from 'react';

export const PREFERENCES_KEY = 'bbb-recording-editor.preferences';
export const PLAYBACK_RATES = [0.5, 1, 1.5, 2];
export const TIMELINE_ZOOMS = [1, 2, 4, 8, 16];
export const PREVIEW_SPLIT_MIN = 0.2;
export const PREVIEW_SPLIT_MAX = 0.8;
export const DEFAULT_PREFERENCES = Object.freeze({
  volume: 1, muted: false, lastVolume: 1, beepPreview: true, rate: 1, zoom: 1, detailWaveOpen: false, detailWaveSpan: 10000, previewSplit: 0.75, skipChimeConfirm: false,
});
const validVolume = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY));
    if (!saved || saved.version !== 1 || Array.isArray(saved)) return { ...DEFAULT_PREFERENCES };
    const volume = validVolume(saved.volume) ? saved.volume : 1;
    return {
      volume,
      muted: typeof saved.muted === 'boolean' ? saved.muted : false,
      lastVolume: validVolume(saved.lastVolume) && saved.lastVolume > 0 ? saved.lastVolume : volume || 1,
      beepPreview: typeof saved.beepPreview === 'boolean' ? saved.beepPreview : true,
      rate: PLAYBACK_RATES.includes(saved.rate) ? saved.rate : 1,
      zoom: TIMELINE_ZOOMS.includes(saved.zoom) ? saved.zoom : 1,
      detailWaveOpen: saved.detailWaveOpen === true,
      detailWaveSpan: [5000, 10000, 30000].includes(saved.detailWaveSpan) ? saved.detailWaveSpan : 10000,
      previewSplit: typeof saved.previewSplit === 'number' && Number.isFinite(saved.previewSplit)
        && saved.previewSplit >= PREVIEW_SPLIT_MIN && saved.previewSplit <= PREVIEW_SPLIT_MAX
        ? saved.previewSplit : DEFAULT_PREFERENCES.previewSplit,
      skipChimeConfirm: saved.skipChimeConfirm === true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export default function useEditorPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ version: 1, ...preferences })); }
    catch { /* Storage restrictions must not prevent editing or changing controls. */ }
  }, [preferences]);
  const updatePreferences = changes => setPreferences(current => ({ ...current, ...changes }));
  return [preferences, updatePreferences];
}
