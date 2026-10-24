import React from 'react';
import { createRoot } from 'react-dom/client';
import OptionsApp from './OptionsApp';
import './options.css';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <OptionsApp />
    </React.StrictMode>,
  );
}
