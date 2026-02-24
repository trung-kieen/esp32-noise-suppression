// src/Dashboard.tsx
import { useWebSocketData } from './core/websocket.service';
import Waveform from './features/Waveform';
import Spectrogram from './features/Spectrogram';
import MetricsPanel from './features/MetricsPanel';

export default function Dashboard() {
  const { data, isConnected } = useWebSocketData();

  return (
    <div style={{ fontFamily: 'sans-serif', background: '#0d1117', color: '#e6edf3', minHeight: '100vh', padding: 24 }}>
      <h1 style={{ textAlign: 'center' }}>Real-time Noise Suppression Dashboard</h1>

      {!isConnected && (
        <div style={{ color: 'orange', textAlign: 'center', margin: '20px 0' }}>
          ⏳ Connecting to ESP32-S3 ...
        </div>
      )}

      <MetricsPanel data={data} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32, marginTop: 32 }}>
        <div>
          <Waveform data={data} label="Raw Waveform" color="#ff5555" />
        </div>
        <div>
          <Waveform data={data} label="Clean Waveform" color="#55ff55" />
        </div>

        <div style={{ display: 'flex', gap: 32 }}>
          <Spectrogram data={data} type="raw" />
          <Spectrogram data={data} type="clean" />
        </div>
      </div>
    </div>
  );
}
