// src/features/metrics/MetricsPanel.tsx
// Real-time metrics display: SNR, VAD, Latency, Packet Loss

import React from 'react';

interface MetricsPanelProps {
  snr: number;
  vad: number;
  latencyMs: number;
  packetLoss: number;
  batchSeq: number;
  connected: boolean;
}

const MetricsPanel: React.FC<MetricsPanelProps> = ({
  snr,
  vad,
  latencyMs,
  packetLoss,
  batchSeq,
  connected
}) => {
  // VAD probability bar (0-1)
  const vadPercent = Math.max(0, Math.min(100, vad * 100));

  // Latency color coding
  const getLatencyColor = (ms: number): string => {
    if (ms < 50) return '#00ff88';
    if (ms < 80) return '#ffaa00';
    return '#ff4444';
  };

  // SNR color coding
  const getSnrColor = (db: number): string => {
    if (db > 20) return '#00ff88';
    if (db > 10) return '#ffaa00';
    return '#ff4444';
  };

  const styles = {
    container: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
      gap: '15px',
      padding: '20px',
      backgroundColor: '#0f0f1a',
      borderRadius: '12px',
      border: '1px solid #2a2a3e'
    },
    card: {
      backgroundColor: '#1a1a2e',
      padding: '15px',
      borderRadius: '8px',
      border: '1px solid #2a2a3e',
      position: 'relative' as const,
      overflow: 'hidden'
    },
    label: {
      fontSize: '11px',
      textTransform: 'uppercase' as const,
      color: '#8888a0',
      marginBottom: '5px',
      letterSpacing: '1px'
    },
    value: {
      fontSize: '28px',
      fontWeight: 'bold',
      fontFamily: 'monospace',
      color: '#ffffff'
    },
    unit: {
      fontSize: '14px',
      color: '#666680',
      marginLeft: '5px'
    },
    bar: {
      width: '100%',
      height: '4px',
      backgroundColor: '#2a2a3e',
      borderRadius: '2px',
      marginTop: '10px',
      overflow: 'hidden'
    },
    barFill: (color: string, percent: number) => ({
      width: `${percent}%`,
      height: '100%',
      backgroundColor: color,
      transition: 'width 0.1s ease-out',
      borderRadius: '2px'
    }),
    status: {
      position: 'absolute' as const,
      top: '10px',
      right: '10px',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: connected ? '#00ff88' : '#ff4444',
      boxShadow: connected ? '0 0 10px #00ff88' : '0 0 10px #ff4444'
    }
  };

  return (
    <div style={styles.container}>
      {/* Connection Status */}
      <div style={styles.card}>
        <div style={styles.status} />
        <div style={styles.label}>Connection</div>
        <div style={{...styles.value, color: connected ? '#00ff88' : '#ff4444'}}>
          {connected ? 'ONLINE' : 'OFFLINE'}
        </div>
        <div style={{fontSize: '12px', color: '#666680', marginTop: '5px'}}>
          Batch #{batchSeq}
        </div>
      </div>

      {/* SNR */}
      <div style={styles.card}>
        <div style={styles.label}>Signal-to-Noise Ratio</div>
        <div style={{...styles.value, color: getSnrColor(snr)}}>
          {snr.toFixed(1)}
          <span style={styles.unit}>dB</span>
        </div>
        <div style={styles.bar}>
          <div style={styles.barFill(getSnrColor(snr), Math.min(100, (snr / 40) * 100))} />
        </div>
      </div>

      {/* VAD */}
      <div style={styles.card}>
        <div style={styles.label}>Voice Activity Detection</div>
        <div style={{...styles.value, color: vad > 0.5 ? '#00ff88' : '#ff4444'}}>
          {(vad * 100).toFixed(0)}
          <span style={styles.unit}>%</span>
        </div>
        <div style={styles.bar}>
          <div style={styles.barFill(vad > 0.5 ? '#00ff88' : '#ff4444', vadPercent)} />
        </div>
        <div style={{fontSize: '11px', color: '#666680', marginTop: '5px'}}>
          {vad > 0.5 ? 'SPEECH DETECTED' : 'SILENCE'}
        </div>
      </div>

      {/* Latency */}
      <div style={styles.card}>
        <div style={styles.label}>End-to-End Latency</div>
        <div style={{...styles.value, color: getLatencyColor(latencyMs)}}>
          {latencyMs.toFixed(0)}
          <span style={styles.unit}>ms</span>
        </div>
        <div style={styles.bar}>
          <div style={styles.barFill(getLatencyColor(latencyMs), Math.min(100, (latencyMs / 100) * 100))} />
        </div>
      </div>

      {/* Packet Loss */}
      <div style={styles.card}>
        <div style={styles.label}>Packet Loss</div>
        <div style={{...styles.value, color: packetLoss === 0 ? '#00ff88' : '#ff4444'}}>
          {packetLoss}
          <span style={styles.unit}>pkts</span>
        </div>
        <div style={{fontSize: '11px', color: '#666680', marginTop: '5px'}}>
          {packetLoss === 0 ? 'NO LOSS' : 'DROPPED PACKETS'}
        </div>
      </div>
    </div>
  );
};

export default MetricsPanel;
