import React from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import MeetingList from './MeetingList';
import { IntlProvider } from 'react-intl';

const meeting = (name, publication, recording = 'marked', raw = true) => ({
  id: `${name}-1700000000000`, name, date: '2026-10-10T08:00:00Z',
  duration_ms: 851185, recorded_duration_ms: recording === 'unmarked' ? 0 : 229257,
  publication_status: publication, generation_status: ['published', 'unpublished'].includes(publication) ? 'generated' : publication,
  recording_status: recording, raw_available: raw, raw_data_status: raw ? 'present' : 'missing', warnings: [],
});
const meetings = [meeting('Public', 'published'), meeting('Private', 'unpublished'),
  meeting('No marks', 'not_generated', 'unmarked'), meeting('Working', 'processing'),
  { ...meeting('Missing raw', 'unpublished', 'unknown', false), recorded_duration_ms: null },
  meeting('Unknown', 'unknown')];
let container;
let root;
let onOpen;
let onRefresh;
const localized = component => <IntlProvider locale="ja" defaultLocale="ja" messages={{}}>{component}</IntlProvider>;
const rows = () => [...container.querySelectorAll('.re-meeting')];
const select = axis => container.querySelector(`[aria-label="${axis === 'raw' ? 'rawデータの状態' : '録画の生成・公開状態'}"]`);
async function filter(value, axis = 'publication') {
  await act(async () => { Simulate.change(select(axis), { target: { value } }); });
}

beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  onOpen = jest.fn(); onRefresh = jest.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(localized(<MeetingList meetings={meetings} selectedId={meetings[0].id} onOpen={onOpen} onRefresh={onRefresh} />)); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); });

test('shows independent badges, meeting length, marked duration and missing raw', () => {
  expect(rows()).toHaveLength(6);
  expect(rows()[0].textContent).toContain('会議 14:11 · 録画区間 03:49');
  expect(rows()[0].querySelector('.re-status-published').textContent).toBe('生成済み · 公開');
  expect(rows()[2].textContent).toContain('録画区間 00:00');
  expect(rows()[2].querySelector('.re-status-unmarked').textContent).toContain('録画区間なし');
  expect(rows()[4].textContent).toContain('録画区間 —');
  expect(rows()[4].querySelector('.re-status-missing').textContent).toBe('rawデータなし');
});

test('renamed public and private recordings also show room names without duplicate or missing-name rows', async () => {
  const entries = [
    { ...meeting('講義 <第1回> & introduction', 'published'), meeting_name: '会議室 Alpha' },
    { ...meeting('非公開の講義', 'unpublished'), meeting_name: '会議室 Beta' },
    { ...meeting('会議室 Gamma', 'unpublished', 'unmarked'), meeting_name: '会議室 Gamma' },
    meeting('タイトルのみ', 'published'),
  ];
  await act(async () => root.render(localized(<MeetingList meetings={entries} onOpen={onOpen} onRefresh={onRefresh} />)));
  expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(entries.map(entry => entry.name));
  expect(rows()[0].querySelector('.re-meeting-room').textContent).toBe('会議室: 会議室 Alpha');
  expect(rows()[1].querySelector('.re-meeting-room').textContent).toBe('会議室: 会議室 Beta');
  expect(rows()[2].querySelector('.re-meeting-room')).toBeNull();
  expect(rows()[3].querySelector('.re-meeting-room')).toBeNull();
  expect(rows()[0].querySelector('strong').children).toHaveLength(0);
  await filter('unpublished');
  expect(rows()[0].querySelector('.re-meeting-room').textContent).toBe('会議室: 会議室 Beta');
  await act(async () => Simulate.click(rows()[0]));
  expect(onOpen).toHaveBeenCalledWith(entries[1].id);
});

test('hierarchical parent and child filters include correct rows and counts', async () => {
  const expectations = { generated: ['Public', 'Private', 'Missing raw'], published: ['Public'], unpublished: ['Private', 'Missing raw'],
    not_generated: ['No marks'], processing: ['Working'], generation_unknown: ['Unknown'], publication_unknown: [] };
  for (const [value, names] of Object.entries(expectations)) {
    await filter(value);
    expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(names);
    expect(select('publication').querySelector(`option[value="${value}"]`).textContent).toContain(`(${names.length})`);
  }
  await filter('all');
  const rawExpectations = { present: ['Public', 'Private', 'No marks', 'Working', 'Unknown'],
    marked: ['Public', 'Private', 'Working', 'Unknown'], unmarked: ['No marks'], missing: ['Missing raw'], ranges_unknown: [], raw_unknown: [] };
  for (const [value, names] of Object.entries(rawExpectations)) {
    await filter(value, 'raw');
    expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(names);
    expect(select('raw').querySelector(`option[value="${value}"]`).textContent).toContain(`(${names.length})`);
  }
  expect(onOpen).not.toHaveBeenCalled();
  expect(container.textContent).toContain('選択中の会議は絞り込み結果に含まれません');
  await filter('all', 'raw');
  expect(rows()[0].classList.contains('active')).toBe(true);
  expect(select('raw').querySelector('optgroup')).toBeNull();
  expect(select('publication').querySelector('optgroup')).toBeNull();
  expect(select('raw').querySelector('[value="present"]').textContent).toBe('rawあり (5)');
  expect(select('publication').querySelector('[value="generated"]').textContent).toBe('生成済み (3)');
  expect(select('raw').querySelector('[value="marked"]').textContent).toBe('\u2003↳ 録画区間あり (4)');
  expect(select('publication').querySelector('[value="published"]').textContent).toBe('\u2003↳ 公開 (1)');
  expect(select('raw').querySelector('[value="marked"]').getAttribute('aria-label')).toContain('rawデータあり');
});

test('opening meetings and refreshing still call the supplied actions', async () => {
  await act(async () => { Simulate.click(rows()[1]); });
  expect(onOpen).toHaveBeenCalledWith(meetings[1].id);
  await act(async () => { Simulate.click(container.querySelector('[title="一覧を更新"]')); });
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('new meeting data keeps the filter and gives a clear empty result', async () => {
  await filter('published');
  await act(async () => { root.render(localized(<MeetingList meetings={[meetings[1]]} selectedId={meetings[1].id} onOpen={onOpen} onRefresh={onRefresh} />)); });
  expect(select('publication').value).toBe('published');
  expect(rows()).toHaveLength(0);
  expect(container.textContent).toContain('条件に一致する会議がありません');
});

test('unknown metadata is not guessed to be published or unmarked', async () => {
  await act(async () => { root.render(localized(<MeetingList meetings={[{ id: 'fallback-1700000000000', warnings: ['Metadata unavailable'] }]} onOpen={onOpen} onRefresh={onRefresh} />)); });
  expect(rows()[0].textContent).toContain('会議 — · 録画区間 —');
  expect(rows()[0].textContent).toContain('rawデータの状態を確認できない');
  expect(rows()[0].textContent).toContain('生成状態不明');
  expect(rows()[0].textContent).not.toContain('録画区間不明');
  expect(rows()[0].textContent).toContain('Metadata unavailable');
  await filter('unmarked', 'raw');
  expect(rows()).toHaveLength(0);
});

test('all dates is the default and period filters combine with status counts without changing the editor', async () => {
  const now = Date.UTC(2026, 9, 31, 12);
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const dated = (name, days, publication = 'published', raw = true) => ({
    ...meeting(name, publication, 'marked', raw), date: new Date(now - days * 86400000).toISOString(),
  });
  const entries = [dated('Recent missing', 2, 'unpublished', false), dated('Boundary', 14),
    { ...dated('Just older', 14), date: new Date(now - 14 * 86400000 - 1).toISOString() },
    dated('Retained old raw', 400),
    { ...dated('ID fallback', 30), id: `fallback-${now - 30 * 86400000}`, date: null }];
  const renderList = () => root.render(localized(<MeetingList meetings={entries} selectedId={entries[3].id} dirty onOpen={onOpen} onRefresh={onRefresh} />));
  await act(async () => renderList());
  const periodSelect = () => container.querySelector('[aria-label="会議の期間"]');
  expect(periodSelect().value).toBe('all');
  expect(rows()).toHaveLength(5);
  expect(container.querySelector('h2').textContent).toBe('録画データ');
  await act(async () => Simulate.change(periodSelect(), { target: { value: '14' } }));
  expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(['Recent missing', 'Boundary']);
  expect(container.querySelector('option[value="published"]').textContent).toContain('(1)');
  expect(container.textContent).toContain('選択中の会議は絞り込み結果に含まれません');
  await filter('published');
  expect(rows()).toHaveLength(1);
  await act(async () => Simulate.change(periodSelect(), { target: { value: '30' } }));
  expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(['Boundary', 'Just older', 'ID fallback']);
  await act(async () => renderList());
  expect(periodSelect().value).toBe('30');
  expect(select('publication').value).toBe('published');
  await act(async () => Simulate.change(periodSelect(), { target: { value: 'all' } }));
  expect(rows().map(row => row.querySelector('strong').textContent)).toContain('Retained old raw');
  expect(onOpen).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
});

test('only missing-raw ungenerated unknown-interval candidates offer deletion without opening the editor', async () => {
  const orphan = meeting('Orphan', 'not_generated', 'unknown', false);
  const onDelete = jest.fn();
  await act(async () => root.render(localized(<MeetingList meetings={[...meetings, orphan]} onOpen={onOpen} onRefresh={onRefresh} onDelete={onDelete} />)));
  const buttons = container.querySelectorAll('.re-delete-candidate');
  expect(buttons).toHaveLength(1);
  await act(async () => Simulate.click(buttons[0]));
  expect(onDelete).toHaveBeenCalledWith(orphan);
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () => root.render(localized(<MeetingList meetings={[orphan]} dirty onOpen={onOpen} onDelete={onDelete} />)));
  expect(container.querySelector('.re-delete-candidate').disabled).toBe(true);
});

test('missing XML, missing raw files and unavailable presence occupy different raw branches', async () => {
  const entries = [meeting('XML unavailable', 'not_generated', 'unknown'), meeting('Empty raw', 'not_generated', 'unknown', false),
    { ...meeting('Cannot inspect', 'not_generated', 'unknown', false), raw_data_status: 'unknown' }];
  const onDelete = jest.fn();
  await act(async () => root.render(localized(<MeetingList meetings={entries} onOpen={onOpen} onDelete={onDelete} />)));
  expect(rows()[0].textContent).toContain('rawデータあり');
  expect(rows()[0].textContent).toContain('録画区間不明');
  expect(rows()[1].textContent).toContain('rawデータなし');
  expect(rows()[1].textContent).not.toContain('録画区間不明');
  expect(rows()[2].textContent).toContain('rawデータの状態を確認できない');
  expect(container.querySelectorAll('.re-delete-candidate')).toHaveLength(1);
  await filter('ranges_unknown', 'raw');expect(rows()[0].querySelector('strong').textContent).toBe('XML unavailable');
  await filter('missing', 'raw');expect(rows()[0].querySelector('strong').textContent).toBe('Empty raw');
  await filter('raw_unknown', 'raw');expect(rows()[0].querySelector('strong').textContent).toBe('Cannot inspect');
});

test('known generated output with unknown publication is separate from unknown generation', async () => {
  const entries = [{ ...meeting('Visibility unknown', 'unknown'), generation_status: 'generated' }, meeting('Generation unknown', 'unknown')];
  await act(async () => root.render(localized(<MeetingList meetings={entries} onOpen={onOpen} />)));
  expect(rows()[0].textContent).toContain('生成済み · 公開状態不明');
  expect(rows()[1].textContent).toContain('生成状態不明');
  await filter('generated');expect(rows()).toHaveLength(1);
  await filter('publication_unknown');expect(rows()[0].querySelector('strong').textContent).toBe('Visibility unknown');
  await filter('generation_unknown');expect(rows()[0].querySelector('strong').textContent).toBe('Generation unknown');
});

test('raw and generation filters intersect, and counts reflect the other selected axis', async () => {
  await filter('unpublished');
  expect(select('raw').querySelector('[value="present"]').textContent).toContain('(1)');
  expect(select('raw').querySelector('[value="missing"]').textContent).toContain('(1)');
  await filter('marked', 'raw');
  expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(['Private']);
  expect(select('publication').querySelector('[value="unpublished"]').textContent).toContain('(1)');
  await filter('not_generated');expect(rows()).toHaveLength(0);
  expect(select('raw').value).toBe('marked'); // Do not silently reset an empty combination.
  expect(select('raw').querySelector('[value="unmarked"]').textContent).toContain('(1)');
  await filter('unmarked', 'raw');expect(rows().map(row => row.querySelector('strong').textContent)).toEqual(['No marks']);
  expect(onOpen).not.toHaveBeenCalled();expect(onRefresh).not.toHaveBeenCalled();
});

test('an older server reporting raw XML unavailable does not establish raw absence', async () => {
  const legacy = { ...meeting('Legacy', 'not_generated', 'unknown', false) };
  delete legacy.raw_data_status;
  await act(async () => root.render(localized(<MeetingList meetings={[legacy]} onOpen={onOpen} onDelete={jest.fn()} />)));
  expect(rows()[0].textContent).toContain('rawデータの状態を確認できない');
  expect(container.querySelector('.re-delete-candidate')).toBeNull();
  await filter('missing', 'raw');expect(rows()).toHaveLength(0);
});
