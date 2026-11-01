import React from 'react';
import { useEditorI18n } from './i18n';
import { formatTime } from './model';

export default function RecordingTime({ clock, time, sourceControl, duration }) {
  const { t } = useEditorI18n();
  const position = clock.at(time);
  return <div className="re-recording-time">
    <span>{t('sourceClock')}: {sourceControl || <time>{formatTime(time)}</time>}{duration != null && <span> / {formatTime(duration)}</span>}</span>
    <span className="re-edited-clock">{t('editedClock')}: <span className="re-edited-position">{position.empty ? t('editedNoRanges')
      : position.included ? <time>{formatTime(position.time)}</time> : <>{t('editedExcluded')} <small>({t('editedJoin', { time: formatTime(position.time) })})</small></>}</span></span>
    <span className="re-muted">{t('editedDuration')}: <time>{formatTime(clock.total)}</time></span>
  </div>;
}

export function EditedRuler({ clock, positions, overview = false }) {
  const { t } = useEditorI18n();
  return <div className={`re-edited-ruler ${overview ? 're-edited-ruler-overview' : 're-edited-ruler-detail'}`} aria-label={t('editedClock')}>
    {positions.map((source, i) => {
      const value = clock.at(source);
      const text = value.included ? formatTime(value.time) : '—';
      const label = `${t('sourceClock')}: ${formatTime(source)}\n${t('editedClock')}: ${value.included ? text : t(value.empty ? 'editedNoRanges' : 'editedExcluded')}`;
      return <span key={i} style={overview ? { left: `${i * 100 / (positions.length - 1)}%` } : undefined}
        title={label} aria-label={label}>{overview && value.included ? text.slice(0, 8) : text}</span>;
    })}
  </div>;
}
