import React from 'react';
import { createRoot } from 'react-dom/client';
import RecordingEditor from 'components/recording-editor';
import './index.css';

const root = createRoot(document.getElementById('root'));

root.render(<RecordingEditor />);
