import React, { useState } from 'react';
import { formatTime } from './model';
import { rawState, rangeState, generationState, publicationState, matchesRaw, matchesPublication, deletionCandidate } from './meetingListStatus';
import { useEditorI18n } from './i18n';

const meetingTime = meeting => new Date(meeting.date || Number(meeting.id.split('-').pop())).getTime();
const dateRanges = [14, 30, 90, 365];
const durationText = ms => {
  if (!Number.isFinite(ms)) return '—';
  const text = formatTime(ms).slice(0, 8);
  return ms < 3600000 ? text.slice(3) : text;
};

export default function MeetingList({ meetings, selectedId, busy, dirty, onRefresh, onOpen, onDelete }) {
  const { locale, t, diagnostic } = useEditorI18n();
  const [rawFilter, setRawFilter] = useState('all');
  const [publicationFilter, setPublicationFilter] = useState('all');
  const [period, setPeriod] = useState('all');
  const now = Date.now();
  const dated = period === 'all' ? meetings : meetings.filter(meeting => {
    const time = meetingTime(meeting);
    return time >= now - Number(period) * 86400000 && time <= now;
  });
  const visible = dated.filter(meeting => matchesRaw(meeting, rawFilter) && matchesPublication(meeting, publicationFilter));
  const rawCount = value => dated.filter(meeting => matchesPublication(meeting, publicationFilter) && matchesRaw(meeting, value)).length;
  const publicationCount = value => dated.filter(meeting => matchesRaw(meeting, rawFilter) && matchesPublication(meeting, value)).length;
  const option = (value, label, count, parent) => {
    const text = `${t(label)} (${count(value)})`;
    return <option key={value} value={value} aria-label={parent ? `${t(parent)}: ${text}` : undefined}>{parent ? '\u2003↳ ' : ''}{text}</option>;
  };
  const selectedHidden = selectedId && !visible.some(meeting => meeting.id === selectedId);
  return <aside className="re-meetings">
    <div className="re-sidebar-title"><h2>{t('recordingList')}</h2><button disabled={!!busy} onClick={onRefresh} title={t('refreshList')}>↻</button></div>
    <p className="re-muted">{t('recordingListHint')}</p>
    <label className="re-meeting-filter re-meeting-filter-hierarchy">{t('rawFilter')}
      <select aria-label={t('rawFilter')} value={rawFilter} disabled={!!busy} onChange={event => setRawFilter(event.target.value)}>
        {option('all', 'all', rawCount)}
        {option('present', 'rawPresentParent', rawCount)}
        {option('marked', 'marked', rawCount, 'rawPresent')}
        {option('unmarked', 'unmarked', rawCount, 'rawPresent')}
        {option('ranges_unknown', 'rangesUnknown', rawCount, 'rawPresent')}
        {option('missing', 'rawMissing', rawCount)}
        {option('raw_unknown', 'rawUnknown', rawCount)}
      </select>
    </label>
    <label className="re-meeting-filter re-meeting-filter-hierarchy">{t('publicationFilter')}
      <select aria-label={t('publicationFilter')} value={publicationFilter} disabled={!!busy} onChange={event => setPublicationFilter(event.target.value)}>
        {option('all', 'all', publicationCount)}
        {option('generated', 'generated', publicationCount)}
        {option('published', 'published', publicationCount, 'generated')}
        {option('unpublished', 'unpublished', publicationCount, 'generated')}
        {option('publication_unknown', 'publicationUnknown', publicationCount, 'generated')}
        {option('processing', 'processing', publicationCount)}
        {option('not_generated', 'not_generated', publicationCount)}
        {option('generation_unknown', 'generationUnknown', publicationCount)}
      </select>
    </label>
    <label className="re-meeting-filter re-meeting-period">{t('meetingPeriod')}
      <select aria-label={t('meetingPeriodLabel')} value={period} disabled={!!busy} onChange={event => setPeriod(event.target.value)}>
        <option value="all">{t('meetingPeriodAll')}</option>
        {dateRanges.map(days => <option key={days} value={days}>{t('meetingPeriodDays', { days })}</option>)}
      </select>
    </label>
    {visible.map(meeting => {
      const raw = rawState(meeting), recording = rangeState(meeting), generation = generationState(meeting), publication = publicationState(meeting);
      const publicationLabel = generation === 'generated' ? publication === 'unknown' ? 'publicationUnknown' : publication : generation === 'unknown' ? 'generationUnknown' : generation;
      const roomName = typeof meeting.meeting_name === 'string' ? meeting.meeting_name.trim() : '';
      return <div className="re-meeting-entry" key={meeting.id}><button className={`re-meeting ${selectedId === meeting.id ? 'active' : ''}`} disabled={!!busy} onClick={() => onOpen(meeting.id)}>
        <strong>{meeting.name || meeting.id.slice(0, 8)}</strong>
        {roomName && roomName !== meeting.name?.trim() && <small className="re-meeting-room">{t('roomName')}: {roomName}</small>}
        <span>{new Date(meetingTime(meeting)).toLocaleString(locale)}</span>
        <span>{t('durations', { meeting: durationText(meeting.duration_ms), recorded: durationText(meeting.recorded_duration_ms) })}</span>
        <span className="re-meeting-status re-meeting-raw-status">
          <span className={`re-status re-status-${raw === 'missing' ? 'missing' : raw}`} title={t('rawPresenceHint')}>{t(raw === 'present' ? 'rawPresent' : raw === 'missing' ? 'rawMissing' : 'rawUnknown')}</span>
          {raw === 'present' && <span className={`re-status re-status-${recording}`}>↳ {t(recording === 'unknown' ? 'rangesUnknown' : recording)}</span>}
        </span>
        <span className="re-meeting-status"><span className={`re-status re-status-${generation === 'generated' ? publication : generation}`}>{generation === 'generated' ? `${t('generated')} · ` : ''}{t(publicationLabel)}</span></span>
        {meeting.warnings?.length > 0 && <small className="re-meeting-warning">{meeting.warnings.map(diagnostic).join(' / ')}</small>}
      </button>
      {onDelete && deletionCandidate(meeting) && <button className="re-delete-candidate" disabled={!!busy || !!dirty} onClick={() => onDelete(meeting)}>{t('deleteRecording')}</button>}
      </div>;
    })}
    {!visible.length && <p className="re-muted">{t(meetings.length ? 'noMatches' : 'noMeetings')}</p>}
    {selectedHidden && <p className="re-muted">{t('selectionHidden')}</p>}
    {dirty && <p className="re-muted">{t('saveBeforeSwitch')}</p>}
  </aside>;
}
