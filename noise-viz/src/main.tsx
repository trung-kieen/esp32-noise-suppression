// src/main.tsx  (typical Vite starter file – you probably don't need to change it)
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';   // ← global styles if any

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
