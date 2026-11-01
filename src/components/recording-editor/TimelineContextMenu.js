import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function TimelineContextMenu({ context, label, actionLabel, disabled, onAction, onClose, children, className = '' }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: context.x, top: context.y });
  useLayoutEffect(() => {
    const menu = ref.current;
    const bounds = menu.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(context.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(context.y, window.innerHeight - bounds.height - 8)) });
    (menu.querySelector('button:not(:disabled)') || menu).focus({ preventScroll: true });
  }, [context]);
  useEffect(() => {
    const outside = event => { if (!ref.current?.contains(event.target)) onClose(); };
    const close = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  const closeToHandle = () => { context.anchor?.focus({ preventScroll: true }); onClose(); };
  return createPortal(<div ref={ref} className={`re-chime-menu ${className}`} role="menu" tabIndex={-1} aria-label={label}
    style={position} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToHandle(); }
      else if (e.key === 'Tab') closeToHandle();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation(); ref.current.querySelector('button:not(:disabled)')?.focus();
      }
    }}>
    {children}
    <button role="menuitem" disabled={disabled} onClick={() => { closeToHandle(); onAction(); }}>{actionLabel}</button>
  </div>, document.body);
}
