import React from 'react';
import { useEditorI18n } from './i18n';
import { formatTime } from './model';
import TimelineContextMenu from './TimelineContextMenu';

export default function CutChimeMenu({ context, enabled, busy, onToggle, onClose }) {
  const { t } = useEditorI18n();
  return <TimelineContextMenu context={context} label={t('cutChime')} actionLabel={t(enabled ? 'cutChimeRemove' : 'cutChimeAdd')}
    disabled={busy || !context.gap} onAction={() => onToggle(context.gap, !enabled)} onClose={onClose}>
    {context.gap ? <p>{formatTime(context.gap.start_ms)} → {formatTime(context.gap.end_ms)}</p> : <p>{t('cutChimeUnavailable')}</p>}
  </TimelineContextMenu>;
}
