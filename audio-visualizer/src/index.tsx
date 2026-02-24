import React from 'react';
import ReactDOM from 'react-dom/client';
import { AudioDashboard } from './app/dashboard';
import { Layout } from './app/layout';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <Layout>
      <AudioDashboard />
    </Layout>
  </React.StrictMode>
);
