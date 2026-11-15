import { useCallback, useRef, useState } from 'react';

// Transient presentation is separate from errors and the reviewable history.
// This history is in memory and belongs to the currently opened recording.
export default function useEditorNotifications() {
  const sequence = useRef(0);
  const [entries, setEntries] = useState([]);
  const [toast, setToast] = useState(null);
  const [error, storeError] = useState('');
  const [unresolved, setUnresolved] = useState({});
  const lastErrors = useRef({});
  const currentSource = useRef(null);
  const publish = useCallback((kind, message) => {
    const entry = { id: ++sequence.current, kind, message };
    setEntries(items => [...items, entry].slice(-20));
    setToast(entry);
  }, []);
  const setMessage = useCallback(message => {
    if (message) publish('success', message);
    else setToast(null);
  }, [publish]);
  const setError = useCallback((message, source = 'general') => {
    storeError(message);
    const key = JSON.stringify(message);
    if (message) {
      currentSource.current = source;
      setUnresolved(items => ({ ...items, [source]: { source, message } }));
      if (key !== lastErrors.current[source]) publish('error', message);
      lastErrors.current[source] = key;
    } else {
      // Clear the current form error, preserving unreviewed errors from other
      // operations. A toast disappearing never resolves an operation's error.
      currentSource.current = null;
      delete lastErrors.current[source];
    }
  }, [publish]);
  const resolveError = useCallback(source => {
    setUnresolved(items => {
      if (!items[source]) return items;
      const next = { ...items }; delete next[source]; return next;
    });
    if (currentSource.current === source) { storeError(''); currentSource.current = null; }
    delete lastErrors.current[source];
  }, []);
  const clear = useCallback(() => {
    setEntries([]); setToast(null); storeError(''); setUnresolved({}); lastErrors.current = {}; currentSource.current = null;
  }, []);
  const dismiss = useCallback(() => setToast(null), []);
  return { entries, toast, error, unresolvedErrors: Object.values(unresolved), setMessage, setError, resolveError, clear, dismiss };
}
