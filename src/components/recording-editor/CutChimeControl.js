import React, { useEffect, useRef, useState } from 'react';
import { useEditorI18n } from './i18n';

export default function CutChimeControl({ enabled, onChange, busy, sampleUrl, count }) {
  const { t } = useEditorI18n();
  const [pending, setPending] = useState(false);
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!pending || !dialog || dialog.open) return;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', ''); // Test environments without dialog support.
  }, [pending]);
  return <section className="re-chime-settings" aria-label={t('cutChime')}>
    <div className="re-chime-tools"><label><input type="checkbox" checked={enabled} disabled={busy}
      onChange={e => { if (e.target.checked) setPending(true); else { setPending(false); onChange(false); } }} /> {t('cutChime')}</label>
      <audio controls preload="none" src={sampleUrl} aria-label={t('cutChimeSample')} />
      <span className="re-muted">{enabled ? t('cutChimeCount', { count }) : t('cutChimeOff')}</span>
    </div>
    {pending && <dialog ref={dialogRef} className="re-review re-chime-confirm" role="alertdialog" aria-modal="true" aria-labelledby="re-chime-title" aria-describedby="re-chime-warning"
      onCancel={() => setPending(false)}>
      <h3 id="re-chime-title">{t('cutChimeConfirmTitle')}</h3>
      <p id="re-chime-warning" className="re-warnings">{t('cutChimeWarning')}</p>
      <button disabled={busy} onClick={() => setPending(false)}>{t('cutChimeCancel')}</button>
      <button disabled={busy} onClick={() => { setPending(false); onChange(true); }}>{t('cutChimeAccept')}</button>
    </dialog>}
    <p className="re-muted">{t('cutChimeHint')}</p>
  </section>;
}
