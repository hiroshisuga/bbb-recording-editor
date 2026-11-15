import React, { useEffect, useId, useRef } from 'react';
import { useEditorI18n } from './i18n';

export default function EditorDialog({ title, onClose, className = '', children }) {
  const { t } = useEditorI18n();
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current, origin = document.activeElement;
    const fallback = element.closest('.recording-editor')?.querySelector('.re-status-toggle');
    if (element.showModal) element.showModal(); else element.setAttribute('open', '');
    return () => {
      if (element.open && element.close) element.close();
      const target = origin?.isConnected && origin !== document.body && !origin.disabled ? origin : fallback;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`re-editor-dialog ${className}`} aria-labelledby={titleId} aria-modal="true"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="re-dialog-heading"><h2 id={titleId}>{title}</h2><button onClick={onClose}>{t('close')}</button></div>
    {children}
  </dialog>;
}
