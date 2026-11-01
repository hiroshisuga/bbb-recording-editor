import React, { useEffect, useRef, useState } from 'react';
import { useEditorI18n } from './i18n';
import { sameChimeGap, CUT_CHIME_SOUNDS } from './model';

export default function CutChimeControl({ gaps, selected, onChange, busy, sampleUrl, sound = 'a', onSoundChange, skipConfirm, onSkipConfirmChange, children }) {
  const { t } = useEditorI18n();
  const [pending, setPending] = useState(null);
  const [audition, setAudition] = useState(false);
  const [sampleError, setSampleError] = useState(false);
  const sample = useRef(null);
  const playVersion = useRef(0);
  const dialogRef = useRef(null);
  useEffect(() => { setPending(null); }, [gaps, busy]);
  useEffect(() => { playVersion.current += 1; setAudition(false); setSampleError(false); }, [sampleUrl]);
  useEffect(() => { if (busy) sample.current?.pause(); }, [busy]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!pending || !dialog || dialog.open) return;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
  }, [pending]);
  const add = next => {
    if (busy) return;
    if (skipConfirm) onChange(next);
    else setPending(next);
  };
  const confirm = skip => {
    if (skip) onSkipConfirmChange(true);
    setPending(null);
    onChange(pending);
  };
  const toggle = (gap, enabled) => {
    if (busy || !gaps.some(item => sameChimeGap(item, gap))) return;
    if (enabled) add([...selected.filter(item => !sameChimeGap(item, gap)), gap]);
    else onChange(selected.filter(item => !sameChimeGap(item, gap)));
  };
  const playSample = () => {
    if (!sample.current) return;
    setSampleError(false);
    const version = ++playVersion.current;
    if (audition) sample.current.pause();
    else {
      sample.current.currentTime = 0;
      sample.current.play().catch(error => {
        if (version === playVersion.current && error.name !== 'AbortError') setSampleError(true);
      });
    }
  };
  return <section className="re-chime-editor" aria-label={t('cutChime')}>
    <div className="re-chime-tools">
      <label>{t('cutChimeSound')} <select aria-label={t('cutChimeSound')} disabled={busy} value={sound} onChange={event => {
        playVersion.current += 1;
        sample.current?.pause();
        onSoundChange(event.target.value);
      }}>{CUT_CHIME_SOUNDS.map(value => <option key={value} value={value}>{t(`cutChimeSound_${value}`)}</option>)}</select></label>
      <button disabled={busy || !gaps.length || selected.length === gaps.length} onClick={() => add(gaps)}>{t('cutChimeAll')}</button>
      <button disabled={busy || !selected.length} onClick={() => onChange([])}>{t('cutChimeClear')}</button>
      <button disabled={busy} onClick={playSample} title={t('cutChimeSample')}>{t(audition ? 'cutChimeSampleStop' : 'cutChimeSamplePlay')}</button>
      <audio key={sampleUrl} ref={sample} preload="none" src={sampleUrl} onPlay={() => setAudition(true)} onPause={() => setAudition(false)} onEnded={() => setAudition(false)} onError={() => setSampleError(true)} />
      <span className="re-muted" role="status" title={t('cutChimeHint')}>{t('cutChimeCount', { count: selected.length })}</span>
      {skipConfirm && <button onClick={() => onSkipConfirmChange(false)}>{t('cutChimeRestoreConfirm')}</button>}
      {sampleError && <span role="alert">{t('cutChimeSampleError')}</span>}
    </div>
    {children(toggle)}
    {pending && <dialog ref={dialogRef} className="re-review re-chime-confirm" role="alertdialog" aria-modal="true" aria-labelledby="re-chime-title" aria-describedby="re-chime-warning"
      onCancel={() => setPending(null)}>
      <h3 id="re-chime-title">{t('cutChimeConfirmTitle')}</h3>
      <p id="re-chime-warning" className="re-warnings">{t('cutChimeWarning')}</p>
      <button disabled={busy} onClick={() => setPending(null)}>{t('cutChimeCancel')}</button>
      <button disabled={busy} onClick={() => confirm(false)}>{t('cutChimeAccept')}</button>
      <button disabled={busy} onClick={() => confirm(true)}>{t('cutChimeAcceptAndSkip')}</button>
    </dialog>}
  </section>;
}
