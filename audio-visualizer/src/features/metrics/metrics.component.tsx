import React from 'react';

interface MetricsProps {
  batchSeq: number;
  timestampMs: number;
  latencyMs: number;
  snr: number;
  vad: number;
  rmsRaw: number;
  packetLoss: number;
  totalPacketLoss?: number;
  connectionStatus: string;
  frameSeq: number;
  serverProcessingMs: number;
  queueDepth: number;
  sampleRate?: number;  // NEW
  connected: boolean;
}

export const MetricsPanel: React.FC<MetricsProps> = ({
  batchSeq,
  timestampMs,
  latencyMs,
  snr,
  vad,
  rmsRaw,
  packetLoss,
  totalPacketLoss,
  connectionStatus,
  frameSeq,
  serverProcessingMs,
  queueDepth,
  sampleRate = 48000, // Default to 48kHz
  connected
}) => {
  const formatDb = (val: number) => `${val.toFixed(1)} dB`;
  const voiceDetected = vad > 0.5;

  // Calculate derived values
  const fs_khz = (sampleRate / 1000).toFixed(1);
  const nyquist = (sampleRate / 2 / 1000).toFixed(1);

  return (
    <div style={styles.container}>
      {/* SAMPLING RATE - NEW BIG DISPLAY */}
      <div style={{...styles.metricBox, ...styles.fsBox}}>
        <div style={styles.fsLabel}>SAMPLING RATE (fs)</div>
        <div style={styles.fsValue}>
          {sampleRate.toLocaleString()} <span style={styles.fsUnit}>Hz</span>
        </div>
        <div style={styles.fsSubtext}>
          {fs_khz} kHz | Nyquist: {nyquist} kHz | 16-bit PCM
        </div>
      </div>

      {/* Connection Status */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Status</div>
        <div style={{
          ...styles.value,
          color: connected ? '#00ff88' : '#ff4444'
        }}>
          {connected ? '🟢 Online' : '🔴 Offline'}
        </div>
        <div style={styles.subtext}>{connectionStatus}</div>
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

      {/* RMS Raw */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Input Level</div>
        <div style={styles.value}>{rmsRaw.toFixed(4)}</div>
        <div style={styles.subtext}>RMS Raw</div>
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
        <div style={styles.subtext}>Server: {serverProcessingMs.toFixed(1)}ms</div>
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
        <div style={styles.subtext}>
          Total: {totalPacketLoss || 0}
        </div>
      </div>

      {/* Batch Info */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Sequence</div>
        <div style={styles.value}>#{batchSeq.toLocaleString()}</div>
        <div style={styles.subtext}>Frame: {frameSeq.toLocaleString()}</div>
      </div>

      {/* Queue */}
      <div style={styles.metricBox}>
        <div style={styles.label}>Queue</div>
        <div style={styles.value}>{queueDepth}</div>
        <div style={styles.subtext}>Depth</div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
    gap: '12px',
    padding: '15px',
    backgroundColor: '#0a0a0a',
    borderBottom: '1px solid #333',
  },
  metricBox: {
    backgroundColor: '#1a1a1a',
    padding: '12px',
    borderRadius: '6px',
    border: '1px solid #333',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: '100px',
  },
  // NEW: Special styling for fs box
  fsBox: {
    gridColumn: 'span 2', // Takes 2 columns
    backgroundColor: '#0f2f1f', // Dark green background
    border: '2px solid #00ff88',
    minWidth: '200px',
  },
  fsLabel: {
    color: '#00ff88',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '2px',
    marginBottom: '4px',
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  fsValue: {
    color: '#00ff88',
    fontSize: '32px',
    fontWeight: 'bold',
    fontFamily: 'monospace',
    textShadow: '0 0 10px rgba(0,255,136,0.3)',
  },
  fsUnit: {
    fontSize: '18px',
    color: '#00aa66',
  },
  fsSubtext: {
    color: '#66aa88',
    fontSize: '11px',
    marginTop: '4px',
    fontFamily: 'monospace',
  },
  label: {
    color: '#888',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    marginBottom: '6px',
    fontFamily: 'monospace',
  },
  value: {
    color: '#fff',
    fontSize: '20px',
    fontWeight: 'bold',
    fontFamily: 'monospace',
  },
  subtext: {
    color: '#666',
    fontSize: '9px',
    marginTop: '4px',
    fontFamily: 'monospace',
  },
  vadContainer: {
    width: '100%',
    height: '18px',
    backgroundColor: '#333',
    borderRadius: '9px',
    overflow: 'hidden',
    position: 'relative',
    marginBottom: '4px',
  },
  vadBar: {
    height: '100%',
    transition: 'width 0.1s ease-out, background-color 0.2s',
    borderRadius: '9px',
  },
  vadText: {
    position: 'absolute',
    right: '6px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#fff',
    fontSize: '10px',
    fontWeight: 'bold',
    textShadow: '0 1px 2px rgba(0,0,0,0.8)',
  },
  vadStatus: {
    fontSize: '11px',
    fontWeight: 'bold',
    fontFamily: 'monospace',
    marginTop: '2px',
  },
};
