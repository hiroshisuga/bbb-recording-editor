import React, { memo } from 'react';
import { useEditorI18n } from './i18n';
import { formatTime } from './model';

function ContentTrack({ segments, duration, setSelection, seek }) {
  const { t } = useEditorI18n();
  return <div className="re-track re-content-track"><span className="re-track-label">{t('contentDisplay')}</span>
    {segments.map((segment, index) => {
      const description = `${t(`content_${segment.source}`)} · ${formatTime(segment.start_ms)} → ${formatTime(segment.end_ms)}\n${t(segment.edited ? 'contentEdited' : segment.inferred ? 'contentInferred' : 'contentRecorded')}${segment.edited ? ` · ${t('contentChangedFrom', { source: t(`content_${segment.original_source}`) })}` : ''}${segment.available ? '' : ` · ${t(segment.source === 'none' ? 'contentHidden' : 'contentUnavailable')}`}`;
      return <button key={index} className={`re-content-segment re-content-${segment.source}${segment.edited ? ' re-content-edited' : ''}${segment.available ? '' : ' re-content-unavailable'}`}
        style={{ left: `${segment.start_ms / duration * 100}%`, width: `${(segment.end_ms - segment.start_ms) / duration * 100}%` }} aria-label={description} data-tooltip={description}
        onPointerDown={event => event.stopPropagation()} onClick={() => { setSelection({ start_ms: segment.start_ms, end_ms: segment.end_ms }); seek(segment.start_ms); }}>{t(`content_${segment.source}`)}</button>;
    })}
  </div>;
}
export default memo(ContentTrack);
