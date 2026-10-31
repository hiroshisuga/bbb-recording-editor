import React from 'react';
import { useEditorI18n } from './i18n';
import { formatTime } from './model';

export const validSelection = selection => Number.isFinite(selection.start_ms)
  && Number.isFinite(selection.end_ms) && selection.end_ms > selection.start_ms;

const points = [['start_ms', 'endpointStart'], ['end_ms', 'endpointEnd']];

export default function SelectionMarkers({ selection, start, end }) {
  const { t } = useEditorI18n();
  return <div className="re-selection-markers">{points.map(([edge, label]) => {
    const value = selection[edge];
    if (!Number.isFinite(value) || value < start || value > end || end <= start) return null;
    const pct = (value - start) / (end - start) * 100;
    return <div key={edge} className={`re-selection-point re-selection-${edge}`} role="img"
      aria-label={`${t(label)} ${formatTime(value)}`} style={{ left: `${pct}%`, marginLeft: pct === 100 ? -2 : 0 }}>
      <span style={{ transform: pct < 10 ? 'none' : pct > 90 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{t(label)}</span>
    </div>;
  })}</div>;
}

export function SelectionOffscreen({ selection, start, end, onShow }) {
  const { t } = useEditorI18n();
  return <div className="re-selection-offscreen">{points.map(([edge, label]) => {
    const value = selection[edge];
    if (!Number.isFinite(value) || (value >= start && value <= end)) return null;
    return <button key={edge} onClick={() => onShow(value)}>{t('showSelectionPoint', {
      direction: value < start ? '←' : '→', point: t(label), time: formatTime(value),
    })}</button>;
  })}</div>;
}
