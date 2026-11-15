import React, { useCallback, useEffect, useState } from 'react';
import { useEditorI18n } from './i18n';

function Toast({ item, dismiss, onDetails }) {
  const { t, message } = useEditorI18n();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return undefined;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [item.id, dismiss, hovered, focused]);
  const shortMessage = { rawSaved: 'rawSavedToast', resetCompleted: 'resetCompletedToast', resetUnmarkedCompleted: 'resetUnmarkedToast', rebuildCompleted: 'rebuildCompletedToast' };
  const text = item.message?.id && shortMessage[item.message.id] ? { id: shortMessage[item.message.id] } : item.message;
  return <div className={`re-toast ${item.kind === 'error' ? 're-error' : item.kind === 'progress' ? 're-notice' : 're-success'}`}
    role={item.kind === 'error' ? 'alert' : 'status'} aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <button className="re-toast-message" onClick={dismiss}>{item.kind === 'progress' && '◌ '}{message(text)}</button>
    <div className="re-toast-actions"><button onClick={onDetails}>{t('notificationDetails')}</button><button aria-label={t('dismissNotification')} onClick={dismiss}>×</button></div>
  </div>;
}

export default function EditorToast({ busy, toast, dismiss, onDetails }) {
  const [progressVisible, setProgressVisible] = useState(false);
  const hideProgress = useCallback(() => setProgressVisible(false), []);
  const working = !!busy;
  useEffect(() => { setProgressVisible(working); if (working) dismiss(); }, [working, dismiss]);
  const progress = working && progressVisible;
  const item = progress ? { id: 'progress', kind: 'progress', message: busy } : toast;
  return item ? <Toast key={item.id} item={item} dismiss={progress ? hideProgress : dismiss} onDetails={onDetails} /> : null;
}
