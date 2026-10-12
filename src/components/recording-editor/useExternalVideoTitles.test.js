import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import useExternalVideoTitles from './useExternalVideoTitles';

let root, container, titles;
function Harness(props) { titles = useExternalVideoTitles(props.videos, props.id, props.load); return null; }
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });
const render = props => act(async () => root.render(<Harness {...props} />));

test('deduplicates URLs, respects recorded titles and continues after optional metadata failures', async () => {
  const load = jest.fn(async (id, url) => {
    if (url === 'failed') throw Error('offline');
    return { title: url === 'empty' ? null : 'Fetched title' };
  });
  await render({ id: 'one', load, videos: [{ url: 'recorded', title: 'Saved title' }, { url: 'failed' },
    { url: 'empty' }, { url: 'repeat' }, { url: 'repeat' }] });
  expect(load.mock.calls).toEqual([['one', 'failed'], ['one', 'empty'], ['one', 'repeat']]);
  expect(titles).toEqual({ repeat: 'Fetched title' });
});

test('discards late metadata when another recording is opened and stops old requests', async () => {
  let resolve;
  const load = jest.fn(id => id === 'one' ? new Promise(done => { resolve = done; }) : Promise.resolve({ title: 'New title' }));
  await render({ id: 'one', load, videos: [{ url: 'same' }, { url: 'never-requested' }] });
  await render({ id: 'two', load, videos: [{ url: 'same' }] });
  await act(async () => resolve({ title: 'Stale title' }));
  expect(titles).toEqual({ same: 'New title' });
  expect(load.mock.calls).toEqual([['one', 'same'], ['two', 'same']]);
});
