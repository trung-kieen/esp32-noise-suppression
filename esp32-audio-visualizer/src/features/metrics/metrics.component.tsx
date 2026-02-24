// src/features/metrics/metrics.component.tsx
import React from 'react';

interface MetricsProps {
  vad: number;
  snr: number;
  latencyMs: number;
  packetLoss: number;
  batchSeq: number;
  peakRaw: number;
  rmsDb: number;
  voiceDetected: boolean;
  connected: boolean;
}

export const MetricsPanel: React.FC<MetricsProps> = ({
  vad,
  snr,
  latencyMs,
  packetLoss,
  batchSeq,
  peakRaw,
  rmsDb,
  voiceDetected,
  connected
}) => {
  const formatDb = (val: number) => `${val.toFixed(1)} dB`;

  return (
    <div style={styles.container}>
      {/* Connection Status */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Status</div>
        <div style={{
          ...styles.value,
          color: connected ? '#00ff88' : '#ff4444'
        }}>
          {connected ? '🟢 Connected' : '🔴 Disconnected'}
        </div>
      </div>

      {/* VAD */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Voice Activity</div>
        <div style={styles.vadContainer}>
          <div style={{
            ...styles.vadBar,
            width: `${vad * 100}%`,
            backgroundColor: voiceDetected ? '#00ff88' : '#ffaa00'
          }} />
          <span style={styles.vadText}>{(vad * 100).toFixed(0)}%</span>
        </div>
        <div style={{
          ...styles.vadStatus,
          color: voiceDetected ? '#00ff88' : '#888'
        }}>
          {voiceDetected ? '🎤 SPEAKING' : '🔇 SILENT'}
        </div>
      </div>

      {/* SNR */}
      <div style={styles.metricBox}>
        <div style={styles.label}>SNR</div>
        <div style={{
          ...styles.value,
          color: snr > 20 ? '#00ff88' : snr > 10 ? '#ffaa00' : '#ff4444'
        }}>
          {formatDb(snr)}
        </div>
        <div style={styles.subtext}>
          {snr > 20 ? 'Excellent' : snr > 10 ? 'Good' : 'Poor'}
        </div>
      </div>

      {/* Latency */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Latency</div>
        <div style={{
          ...styles.value,
          color: latencyMs < 60 ? '#00ff88' : latencyMs < 100 ? '#ffaa00' : '#ff4444'
        }}>
          {latencyMs.toFixed(0)} ms
        </div>
        <div style={styles.subtext}>End-to-end</div>
      </div>

      {/* Packet Loss */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Packet Loss</div>
        <div style={{
          ...styles.value,
          color: packetLoss === 0 ? '#00ff88' : '#ff4444'
        }}>
          {packetLoss === 0 ? '0' : `⚠️ ${packetLoss}`}
        </div>
        <div style={styles.subtext}>Lost batches</div>
      </div>

      {/* Peak Level */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Peak Level</div>
        <div style={styles.value}>{peakRaw.toLocaleString()}</div>
        <div style={styles.subtext}>{formatDb(rmsDb)} RMS</div>
      </div>

      {/* Batch Sequence */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Batch #</div>
        <div style={styles.value}>{batchSeq.toLocaleString()}</div>
        <div style={styles.subtext}>Sequence</div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: '15px',
    padding: '20px',
    backgroundColor: '#0a0a0a',
    borderBottom: '1px solid #333',
  },
  metricBox: {
    backgroundColor: '#1a1a1a',
    padding: '15px',
    borderRadius: '8px',
    border: '1px solid #333',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: '100px',
  },
  label: {
    color: '#888',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    marginBottom: '8px',
    fontFamily: 'monospace',
  },
  value: {
    color: '#fff',
    fontSize: '24px',
    fontWeight: 'bold',
    fontFamily: 'monospace',
  },
  subtext: {
    color: '#666',
    fontSize: '10px',
    marginTop: '4px',
    fontFamily: 'monospace',
  },
  vadContainer: {
    width: '100%',
    height: '20px',
    backgroundColor: '#333',
    borderRadius: '10px',
    overflow: 'hidden',
    position: 'relative',
    marginBottom: '5px',
  },
  vadBar: {
    height: '100%',
    transition: 'width 0.1s ease-out, background-color 0.2s',
    borderRadius: '10px',
  },
  vadText: {
    position: 'absolute',
    right: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#fff',
    fontSize: '11px',
    fontWeight: 'bold',
    textShadow: '0 1px 2px rgba(0,0,0,0.8)',
  },
  vadStatus: {
    fontSize: '12px',
    fontWeight: 'bold',
    fontFamily: 'monospace',
    marginTop: '4px',
  },
};
