import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatTime } from './model';
import { useEditorI18n } from './i18n';
import TimelineContextMenu from './TimelineContextMenu';

const identity = gap => `${gap.start_ms}:${gap.end_ms}`;

// Keep small neighboring cuts accessible without overlapping buttons or the
// boundary drag handles. A cluster opens individual, labeled cut actions.
export function clusterChimeGaps(gaps, duration, width) {
  const groups = [];
  gaps.forEach(gap => {
    const center = Math.max(22, Math.min(width - 22, (gap.start_ms + gap.end_ms) / 2 / duration * width));
    const previous = groups[groups.length - 1];
    if (previous && center - previous.last < 48) {
      previous.gaps.push(gap); previous.last = center;
      previous.center = (previous.first + center) / 2;
    } else groups.push({ gaps: [gap], center, first: center, last: center });
  });
  return groups;
}

export default function ChimeGapControls({ gaps, selected, duration, width, busy, onToggle }) {
  const { t } = useEditorI18n();
  const [menu, setMenu] = useState(null);
  const groups = useMemo(() => clusterChimeGaps(gaps, duration, width), [gaps, duration, width]);
  const enabled = useMemo(() => new Set(selected.map(identity)), [selected]);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(closeMenu, [gaps, busy, width, closeMenu]);
  const description = gap => `${t(enabled.has(identity(gap)) ? 'cutChimeRemove' : 'cutChimeAdd')}\n${formatTime(gap.start_ms)} → ${formatTime(gap.end_ms)}`;
  const openMenu = (event, group) => {
    event.preventDefault(); event.stopPropagation();
    const anchor = event.currentTarget, bounds = anchor.getBoundingClientRect();
    setMenu({ anchor, gaps: group.gaps, x: bounds.left, y: bounds.bottom });
  };
  return <div className="re-chime-controls">
    {gaps.filter(gap => enabled.has(identity(gap))).map(gap => <span key={identity(gap)} className="re-cut-link" aria-hidden="true"
      style={{ left: `${gap.start_ms / duration * 100}%`, width: `${(gap.end_ms - gap.start_ms) / duration * 100}%` }} />)}
    {groups.map(group => {
      const count = group.gaps.filter(gap => enabled.has(identity(gap))).length;
      const single = group.gaps.length === 1;
      const label = single ? description(group.gaps[0]) : t('cutChimeGroup', { count: group.gaps.length, selected: count });
      return <button key={identity(group.gaps[0])} className={`re-chime-toggle${count ? ' re-chime-cue' : ''}${single ? '' : ' re-chime-cluster'}`}
        disabled={busy} style={{ left: `${group.center / width * 100}%` }} aria-label={label} data-tooltip={label}
        aria-pressed={single ? count > 0 : undefined} aria-haspopup={single ? undefined : 'menu'}
        onPointerDown={event => event.stopPropagation()} onClick={event => {
          event.stopPropagation();
          if (single) onToggle(group.gaps[0], count === 0);
          else openMenu(event, group);
        }} onContextMenu={event => openMenu(event, group)}>
        <span aria-hidden="true">{count ? '♪' : '＋'}</span>{!single && <small aria-hidden="true">{group.gaps.length}</small>}
      </button>;
    })}
    {menu && <TimelineContextMenu context={menu} label={t('cutChime')} onClose={closeMenu}>
      {menu.gaps.map(gap => <button key={identity(gap)} role="menuitemcheckbox" aria-checked={enabled.has(identity(gap))} disabled={busy}
        onClick={() => { menu.anchor.focus({ preventScroll: true }); setMenu(null); onToggle(gap, !enabled.has(identity(gap))); }}>
        {enabled.has(identity(gap)) ? '♪' : '＋'} {formatTime(gap.start_ms)} → {formatTime(gap.end_ms)}
      </button>)}
    </TimelineContextMenu>}
  </div>;
}
