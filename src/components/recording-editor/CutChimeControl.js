import React, { useEffect, useRef, useState } from 'react';
import { useEditorI18n } from './i18n';
import { formatTime, sameChimeGap } from './model';

export default function CutChimeControl({ gaps, selected, onChange, busy, sampleUrl, seek }) {
  const { t } = useEditorI18n();
  const [pending, setPending] = useState(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!pending || !dialog || dialog.open) return;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
  }, [pending]);
  const chosen = gap => selected.some(item => sameChimeGap(gap, item));
  return <section className="re-chime-settings" aria-label={t('cutChime')}>
    <div className="re-chime-tools"><strong>{t('cutChime')}</strong>
      <button disabled={busy || !gaps.length || selected.length === gaps.length} onClick={() => setPending(gaps)}>{t('cutChimeAll')}</button>
      <button disabled={busy || !selected.length} onClick={() => onChange([])}>{t('cutChimeClear')}</button>
      <audio controls preload="none" src={sampleUrl} aria-label={t('cutChimeSample')} />
      <span className="re-muted" role="status">{t('cutChimeCount', { count: selected.length })}</span>
    </div>
    {gaps.length ? <details className="re-chime-list" open><summary>{t('cutChimeList')} ({gaps.length})</summary>
      {gaps.map((gap, i) => <div className="re-chime-row" key={`${gap.start_ms}:${gap.end_ms}`}>
        <label><input type="checkbox" checked={chosen(gap)} disabled={busy} onChange={e => {
          if (e.target.checked) setPending([...selected, gap]);
          else onChange(selected.filter(item => !sameChimeGap(item, gap)));
        }} /> {t('cutChimeGap', { number: i + 1, time: formatTime(gap.start_ms), end: formatTime(gap.end_ms) })}</label>
        <button disabled={busy} onClick={() => seek(gap.start_ms)}>{t('cutChimeSeek', { number: i + 1 })}</button>
      </div>)}
    </details> : <p className="re-muted">{t('cutChimeNoGaps')}</p>}
    {pending && <dialog ref={dialogRef} className="re-review re-chime-confirm" role="alertdialog" aria-modal="true" aria-labelledby="re-chime-title" aria-describedby="re-chime-warning"
      onCancel={() => setPending(null)}>
      <h3 id="re-chime-title">{t('cutChimeConfirmTitle')}</h3>
      <p id="re-chime-warning" className="re-warnings">{t('cutChimeWarning')}</p>
      <button disabled={busy} onClick={() => setPending(null)}>{t('cutChimeCancel')}</button>
      <button disabled={busy} onClick={() => { setPending(null); onChange(pending); }}>{t('cutChimeAccept')}</button>
    </dialog>}
    <p className="re-muted">{t('cutChimeHint')}</p>
  </section>;
}
