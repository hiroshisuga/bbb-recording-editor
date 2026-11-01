import React, { useId, useRef, useState } from 'react';
import { useEditorI18n } from './i18n';
import { DEFAULT_PREFERENCES, PREVIEW_SPLIT_MIN, PREVIEW_SPLIT_MAX } from './preferences';

const clamp = value => Math.max(PREVIEW_SPLIT_MIN, Math.min(PREVIEW_SPLIT_MAX, value));

export default function PreviewPanes({ ratio, onChange, content, cameras }) {
  const { t } = useEditorI18n();
  const contentId = useId();
  const container = useRef(null);
  const drag = useRef(null);
  const [pendingRatio, setPendingRatio] = useState(null);
  const shownRatio = pendingRatio ?? ratio;
  const finish = (event, commit) => {
    if (!drag.current || event.pointerId !== drag.current.id) return;
    const value = drag.current.value;
    drag.current = null;
    setPendingRatio(null);
    if (commit) onChange(value);
  };
  return <div ref={container} className={`re-preview${pendingRatio !== null ? ' re-preview--resizing' : ''}`}
    style={{ gridTemplateColumns: `minmax(0, ${shownRatio}fr) 14px minmax(0, ${1 - shownRatio}fr)` }}>
    <div id={contentId} className="re-content-preview">{content}</div>
    <div className="re-preview-divider" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label={t('previewResize')} title={t('previewResizeHint')} aria-controls={contentId}
      aria-valuemin={PREVIEW_SPLIT_MIN * 100} aria-valuemax={PREVIEW_SPLIT_MAX * 100} aria-valuenow={Math.round(shownRatio * 100)}
      onPointerDown={event => {
        if (event.button !== 0 || event.isPrimary === false || drag.current) return;
        const width = container.current.getBoundingClientRect().width - event.currentTarget.getBoundingClientRect().width;
        if (width <= 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width, start: ratio, value: ratio };
        setPendingRatio(ratio);
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active || event.pointerId !== active.id) return;
        active.value = clamp(active.start + (event.clientX - active.x) / active.width);
        setPendingRatio(active.value);
      }}
      onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
      onLostPointerCapture={event => finish(event, true)}
      onDoubleClick={() => onChange(DEFAULT_PREFERENCES.previewSplit)}
      onKeyDown={event => {
        if (drag.current) return;
        const step = event.shiftKey ? 0.1 : 0.02;
        const value = { ArrowLeft: ratio - step, ArrowRight: ratio + step,
          Home: PREVIEW_SPLIT_MIN, End: PREVIEW_SPLIT_MAX }[event.key];
        if (value === undefined) return;
        event.preventDefault(); event.stopPropagation(); onChange(clamp(value));
      }} />
    <div className="re-cameras">{cameras}</div>
  </div>;
}
