// src/app/layout.tsx
// Root layout with global styles

import React from 'react';

export const metadata = {
  title: 'ESP32-S3 Audio Visualizer',
  description: 'Real-time RNNoise audio stream visualization',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <style>{`
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            background-color: #050508;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }

          ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
          }

          ::-webkit-scrollbar-track {
            background: #0a0a0f;
          }

          ::-webkit-scrollbar-thumb {
            background: #2a2a3e;
            border-radius: 4px;
          }

          ::-webkit-scrollbar-thumb:hover {
            background: #3a3a4e;
          }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
