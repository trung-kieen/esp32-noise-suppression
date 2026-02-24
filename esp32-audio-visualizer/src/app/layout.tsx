// src/app/layout.tsx
import React from 'react';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div style={{
      margin: 0,
      padding: 0,
      backgroundColor: '#000',
      minHeight: '100vh',
    }}>
      {children}
    </div>
  );
};
