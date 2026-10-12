import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const TOOLTIP_DELAY = 150;

export default function TimelineTooltip({ targetRef }) {
  const [hint, setHint] = useState(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const bubble = useRef(null);
  const id = useId();
  const hintTarget = hint?.target;

  useEffect(() => {
    const root = targetRef.current;
    if (!root) return undefined;
    let timer;
    let active;
    let pointerFocus = false;
    const find = element => {
      const target = element?.closest?.('[data-tooltip]');
      return target && root.contains(target) ? target : null;
    };
    const hide = () => {
      clearTimeout(timer);
      active = null;
      setHint(null);
    };
    const show = (event, immediate = false) => {
      if (event.pointerType === 'touch' || event.buttons) return;
      const target = find(event.target);
      if (!target || active === target) return;
      hide();
      active = target;
      const rect = target.getBoundingClientRect();
      const x = immediate ? rect.left + rect.width / 2 : event.clientX;
      const y = immediate ? rect.bottom : event.clientY;
      const display = () => {
        if (target.isConnected && active === target) setHint({ target, text: target.dataset.tooltip, x, y });
      };
      if (immediate) display();
      else timer = setTimeout(display, TOOLTIP_DELAY);
    };
    const over = event => show(event);
    const out = event => { if (find(event.relatedTarget) !== active) hide(); };
    const focus = event => { if (!pointerFocus) show(event, true); };
    const down = () => { pointerFocus = true; hide(); };
    const keyboard = event => { pointerFocus = false; if (event.key === 'Escape') hide(); };
    const listeners = [['pointerover', over], ['pointerout', out], ['focusin', focus],
      ['focusout', hide], ['pointerdown', down]];
    listeners.forEach(([name, handler]) => root.addEventListener(name, handler, true));
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      listeners.forEach(([name, handler]) => root.removeEventListener(name, handler, true));
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [targetRef]);

  useEffect(() => {
    if (!hintTarget) return undefined;
    const target = hintTarget;
    const previous = target.getAttribute('aria-describedby');
    const description = [previous, id].filter(Boolean).join(' ');
    target.setAttribute('aria-describedby', description);
    const observer = new MutationObserver(() => setHint(current => current && ({ ...current, text: target.dataset.tooltip })));
    observer.observe(target, { attributes: true, attributeFilter: ['data-tooltip'] });
    return () => {
      observer.disconnect();
      if (target.getAttribute('aria-describedby') === description) {
        if (previous) target.setAttribute('aria-describedby', previous);
        else target.removeAttribute('aria-describedby');
      }
    };
  }, [hintTarget, id]);

  useLayoutEffect(() => {
    if (!hint || !bubble.current) return;
    const { width, height } = bubble.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(hint.x + 12, window.innerWidth - width - 8));
    const below = hint.y + 12;
    const top = Math.max(8, below + height <= window.innerHeight - 8 ? below : hint.y - height - 12);
    setPosition({ left, top });
  }, [hint]);

  return hint ? createPortal(<div ref={bubble} id={id} role="tooltip" className="re-timeline-tooltip" style={position}>{hint.text}</div>, document.body) : null;
}
