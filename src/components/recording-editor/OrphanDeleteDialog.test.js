import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import { EditorLanguageProvider } from './i18n';
import OrphanDeleteDialog from './OrphanDeleteDialog';

let container, root;
const meeting = { id: `${'a'.repeat(40)}-1700000000000`, name: 'Orphan', date: '2023-11-14T12:00:00Z' };
const plan = { revision: 'a'.repeat(64), file_count: 1, bytes: 7, command: `/usr/bin/bbb-record --delete ${meeting.id}`,
  entries: [{ path: '/recording/raw/leftover.txt', type: 'file', bytes: 7 }], retained: '/editor/original-media' };
const dialog = () => document.querySelector('.re-delete-dialog');
const buttons = () => [...dialog().querySelectorAll('button')];
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
async function render(props) { await act(async () => root.render(<EditorLanguageProvider><OrphanDeleteDialog meeting={meeting} {...props} /></EditorLanguageProvider>)); }
async function enter(value) { await act(async () => Simulate.change(dialog().querySelector('input'), { target: { value } })); }

test('reviews paths and retained backups, requires the complete ID and deletes only on explicit confirmation', async () => {
  const remove = jest.fn().mockResolvedValue({ deleted: true }), onDeleted = jest.fn(), onClose = jest.fn();
  const review = jest.fn().mockResolvedValue(plan);
  await render({ review, remove, onDeleted, onClose });
  expect(review).toHaveBeenCalledWith(meeting.id);
  expect(dialog().textContent).toContain(plan.entries[0].path);
  expect(dialog().textContent).toContain(plan.retained);
  expect(remove).not.toHaveBeenCalled();
  expect(buttons()[1].disabled).toBe(true);
  await enter('wrong'); expect(buttons()[1].disabled).toBe(true);
  await enter(meeting.id); expect(buttons()[1].disabled).toBe(false);
  await act(async () => Simulate.click(buttons()[1]));
  expect(remove).toHaveBeenCalledWith(meeting.id, { revision: plan.revision, meeting_id: meeting.id, confirmed: true });
  expect(onDeleted).toHaveBeenCalledWith(meeting.id);
});

test('a failed or stale deletion blocks retries until the user obtains a fresh review', async () => {
  const remove = jest.fn().mockRejectedValue(new Error('Targets changed'));
  await render({ review: jest.fn().mockResolvedValue(plan), remove, onDeleted: jest.fn(), onClose: jest.fn() });
  await enter(meeting.id);
  await act(async () => Simulate.click(buttons()[1]));
  expect(dialog().querySelector('[role="alert"]').textContent).toContain('Targets changed');
  expect(dialog().querySelector('.re-delete-files')).toBeNull();
  expect(buttons()[1].disabled).toBe(true);
});

test('review errors and cancel never issue a deletion', async () => {
  const remove = jest.fn(), onClose = jest.fn();
  await render({ review: jest.fn().mockRejectedValue(new Error('BBB API unavailable')), remove, onDeleted: jest.fn(), onClose });
  expect(dialog().querySelector('[role="alert"]').textContent).toBe('BBB API unavailable');
  expect(buttons()[1].disabled).toBe(true);
  await act(async () => Simulate.click(buttons()[0]));
  expect(onClose).toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
});
