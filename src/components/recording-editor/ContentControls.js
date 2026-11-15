import React, { useEffect, useState } from 'react';
import EditorDialog from './EditorDialog';
import { useEditorI18n } from './i18n';
import { formatTime } from './model';
import { contentChoiceReason, replaceContentOverride } from './contentModel';

export default function ContentControls({ recording, original, current, overrides, selection, busy, onChange }) {
  const { t } = useEditorI18n();
  const [open, setOpen] = useState(false), [source, setSource] = useState('original');
  useEffect(() => setOpen(false), [recording.id, selection.start_ms, selection.end_ms, busy]);
  const reason = contentChoiceReason(recording, original, selection, source);
  const sharedReason = contentChoiceReason(recording, original, selection, 'original') || (!recording.content_edit_supported ? recording.content_edit_reason || 'contentUnsupported' : '');
  return <header className="re-content-heading">
    <strong>{t('contentShowing', { source: t(`content_${current?.source || 'none'}`) })}</strong>
    <span className="re-muted">{current?.edited ? t('contentChangedFrom', { source: t(`content_${current.original_source}`) }) : t(current?.inferred ? 'contentInferred' : 'contentRecorded')}</span>
    <button disabled={busy} aria-haspopup="dialog" onClick={() => {
      const override = overrides.find(r => r.start_ms <= selection.start_ms && r.end_ms >= selection.end_ms);
      setSource(override?.source || 'original'); setOpen(true);
    }}>{t('contentChange')}</button>
    {open && <EditorDialog className="re-content-dialog" title={t('contentChange')} onClose={() => setOpen(false)}>
      <p>{Number.isFinite(selection.start_ms) && Number.isFinite(selection.end_ms) ? `${formatTime(selection.start_ms)} → ${formatTime(selection.end_ms)}` : ''}</p>{sharedReason && <p role="status">{t(sharedReason)}</p>}
      <fieldset><legend>{t('contentDisplay')}</legend>{['original', 'slides', 'screen'].map(value => {
        const unavailable = contentChoiceReason(recording, original, selection, value);
        return <label key={value}><input type="radio" name="content-source" value={value} checked={source === value} disabled={!!unavailable || busy} onChange={() => setSource(value)} />
          <span>{t(value === 'original' ? 'contentRecorded' : `content_${value}`)}{unavailable && unavailable !== sharedReason && <small>{t(unavailable)}</small>}</span></label>;
      })}</fieldset>
      <p className="re-muted">{t('contentEditHint')}</p>
      {reason && reason !== sharedReason && <p role="status">{t(reason)}</p>}
      <button className="re-primary" disabled={busy || !!reason} onClick={() => { onChange(replaceContentOverride(overrides, selection, source)); setOpen(false); }}>{t('contentApply')}</button>
    </EditorDialog>}
  </header>;
}
