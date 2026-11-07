// Older servers only report XML readability. False cannot establish absence.
export const rawState = meeting => ['present', 'missing', 'unknown'].includes(meeting.raw_data_status)
  ? meeting.raw_data_status : meeting.raw_available === true ? 'present' : 'unknown';
export const rangeState = meeting => ['marked', 'unmarked'].includes(meeting.recording_status) ? meeting.recording_status : 'unknown';
export const publicationState = meeting => ['published', 'unpublished'].includes(meeting.publication_status) ? meeting.publication_status : 'unknown';
export const generationState = meeting => ['generated', 'processing', 'not_generated', 'unknown'].includes(meeting.generation_status)
  ? meeting.generation_status : ['published', 'unpublished'].includes(meeting.publication_status) ? 'generated'
    : ['processing', 'not_generated'].includes(meeting.publication_status) ? meeting.publication_status : 'unknown';
export const matchesRaw = (meeting, value) => value === 'all' || (['marked', 'unmarked', 'ranges_unknown'].includes(value)
  ? rawState(meeting) === 'present' && rangeState(meeting) === (value === 'ranges_unknown' ? 'unknown' : value)
  : rawState(meeting) === (value === 'raw_unknown' ? 'unknown' : value));
export const matchesPublication = (meeting, value) => {
  if (value === 'all') return true;
  const generated = generationState(meeting);
  if (['published', 'unpublished', 'publication_unknown'].includes(value)) return generated === 'generated'
    && publicationState(meeting) === (value === 'publication_unknown' ? 'unknown' : value);
  return generated === (value === 'generation_unknown' ? 'unknown' : value);
};
export const deletionCandidate = meeting => rawState(meeting) === 'missing' && generationState(meeting) === 'not_generated'
  && meeting.publication_status === 'not_generated' && rangeState(meeting) === 'unknown' && meeting.raw_available === false;
