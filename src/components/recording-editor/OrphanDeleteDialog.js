import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorI18n } from './i18n';

export default function OrphanDeleteDialog({ meeting, review, remove, onClose, onDeleted }) {
  const { t, diagnostic } = useEditorI18n();
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [confirmation, setConfirmation] = useState('');
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (element.showModal) element.showModal(); else element.setAttribute('open', '');
    let cancelled = false;
    review(meeting.id).then(value => { if (!cancelled) setPlan(value); })
      .catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [meeting.id, review]);
  const confirm = async () => {
    if (busy || !plan || confirmation !== meeting.id) return;
    setBusy(true); setError('');
    try { await remove(meeting.id, { revision: plan.revision, meeting_id: confirmation, confirmed: true }); onDeleted(meeting.id); }
    catch (e) { setError(e.message); setPlan(null); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="re-delete-dialog" aria-labelledby="re-delete-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="re-delete-title">{t('deleteRecording')}</h2>
    <p>{meeting.name}</p><code>{meeting.id}</code><p>{new Date(meeting.date || Number(meeting.id.split('-').pop())).toLocaleString()}</p>
    <p className="re-warnings">{t('deleteWarning')}</p>
    {busy && <p role="status">{t('working')}</p>}
    {error && <p role="alert">{diagnostic(error)}</p>}
    {plan && <>
      <p>{t('deleteSummary', { count: plan.file_count, bytes: plan.bytes.toLocaleString() })}</p>
      <pre>{plan.command}</pre>
      <div className="re-delete-files" tabIndex={0}><ul>{plan.entries.map(entry => <li key={entry.path}><code>{entry.path}</code> {entry.type === 'directory' ? '/' : `${entry.bytes.toLocaleString()} B`}</li>)}</ul></div>
      <p>{t('deleteRetained')} <code>{plan.retained}</code></p>
      <label>{t('deleteTypeId')}<input autoComplete="off" value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} /></label>
    </>}
    <div className="re-delete-actions"><button disabled={busy} onClick={onClose}>{t('close')}</button><button disabled={busy || !plan || confirmation !== meeting.id} onClick={confirm}>{t('deleteConfirm')}</button></div>
  </dialog>, document.body);
}
