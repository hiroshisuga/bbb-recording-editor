import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorI18n } from './i18n';

export default function ChimeSettingsPopover({ anchor, id, onClose, children }) {
  const { t } = useEditorI18n();
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const button = anchor.current.getBoundingClientRect(), box = ref.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(button.left, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(button.bottom + 4, window.innerHeight - box.height - 8)) });
    ref.current.querySelector('select, button:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    const outside = event => { if (!ref.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(false); };
    const scroll = event => { if (!ref.current?.contains(event.target)) onClose(false); };
    const close = () => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close); window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close); window.removeEventListener('blur', close);
    };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} id={id} className="re-chime-settings-popover" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`}
    style={position} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
    }}>
    <div className="re-chime-settings-heading"><strong id={`${id}-title`}>{t('cutChime')}</strong><button onClick={() => onClose(true)}>{t('close')}</button></div>
    {children}
  </div>, document.body);
}
