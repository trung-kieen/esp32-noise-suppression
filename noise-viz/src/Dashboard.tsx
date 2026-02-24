// src/app/dashboard.tsx
// Main dashboard component assembling all visualizer features

import React, { useState, useEffect, useCallback } from 'react';
import { WebSocketService, AudioDTO, ConnectionStatus } from './core/websocket.service';
import WaveformDisplay from './features/waveform/WaveformDisplay';
import SpectrogramHeatmap from './features/spectrogram/SpectrogramHeatmap';
import MetricsPanel from './features/metrics/MetricsPanel';

const Dashboard: React.FC = () => {
  const [audioData, setAudioData] = useState<AudioDTO | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    lastBatchSeq: null,
    packetsReceived: 0,
    packetsLost: 0,
    averageLatency: 0,
  });

  const [historicalSnr, setHistoricalSnr] = useState<number[]>([]);
  const [historicalVad, setHistoricalVad] = useState<number[]>([]);

  const handleMessage = useCallback((dto: AudioDTO) => {
    setAudioData(dto);

    // Keep last 100 values for mini charts
    setHistoricalSnr(prev => [...prev.slice(-99), dto.snr]);
    setHistoricalVad(prev => [...prev.slice(-99), dto.vad]);
  }, []);

  useEffect(() => {
    const wsService = new WebSocketService(
      'ws://localhost:8080',
      handleMessage,
      setConnectionStatus
    );

    wsService.connect();

    return () => {
      wsService.disconnect();
    };
  }, [handleMessage]);

  const styles = {
    container: {
      minHeight: '100vh',
      backgroundColor: '#050508',
      color: '#ffffff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
      padding: '20px'
    },
    header: {
      marginBottom: '20px',
      borderBottom: '1px solid #2a2a3e',
      paddingBottom: '20px'
    },
    title: {
      fontSize: '24px',
      fontWeight: 'bold',
      margin: '0 0 5px 0',
      background: 'linear-gradient(90deg, #00ff88, #00aaff)',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent'
    },
    subtitle: {
      fontSize: '12px',
      color: '#666680',
      margin: 0
    },
    grid: {
      display: 'grid',
      gridTemplateColumns: '1fr',
      gap: '20px',
      maxWidth: '1400px',
      margin: '0 auto'
    },
    section: {
      backgroundColor: '#0f0f1a',
      borderRadius: '12px',
      padding: '20px',
      border: '1px solid #2a2a3e'
    },
    sectionTitle: {
      fontSize: '14px',
      fontWeight: '600',
      marginBottom: '15px',
      color: '#ffffff',
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    },
    indicator: {
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: '#00ff88'
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>ESP32-S3 Audio Stream Visualizer</h1>
        <p style={styles.subtitle}>
          Real-time RNNoise processing • 48kHz • 25Hz update rate • Binary Protocol v1.1
        </p>
      </div>

      <div style={styles.grid}>
        {/* Metrics Panel */}
        <MetricsPanel
          snr={audioData?.snr || 0}
          vad={audioData?.vad || 0}
          latencyMs={audioData?.latencyMs || 0}
          packetLoss={connectionStatus.packetsLost}
          batchSeq={audioData?.batchSeq || 0}
          connected={connectionStatus.connected}
        />

        {/* Waveforms */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <span style={styles.indicator}></span>
            Waveform Comparison (Raw vs Clean)
          </div>
          <WaveformDisplay
            data={audioData?.rawWaveform || []}
            color="#ff6b6b"
            label="RAW PCM (Pre-RNNoise)"
            height={120}
          />
          <WaveformDisplay
            data={audioData?.cleanWaveform || []}
            color="#00ff88"
            label="CLEAN PCM (Post-RNNoise)"
            height={120}
          />
        </div>

        {/* Spectrograms */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            <span style={{...styles.indicator, backgroundColor: '#ffaa00'}}></span>
            Spectrogram Analysis
          </div>
          <div style={{ marginBottom: '15px' }}>
            <div style={{ fontSize: '12px', color: '#8888a0', marginBottom: '5px' }}>Raw Spectrum</div>
            <SpectrogramHeatmap
              spectrumData={audioData?.rawSpectrum || []}
              height={200}
              colorMap="inferno"
            />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#8888a0', marginBottom: '5px' }}>Clean Spectrum</div>
            <SpectrogramHeatmap
              spectrumData={audioData?.cleanSpectrum || []}
              height={200}
              colorMap="viridis"
            />
          </div>
        </div>

        {/* Debug Info */}
        <div style={{...styles.section, fontSize: '12px', fontFamily: 'monospace'}}>
          <div style={styles.sectionTitle}>Protocol Debug</div>
          <div style={{ color: '#666680', lineHeight: '1.6' }}>
            <div>Packet Size: 7,744 bytes (SSOT v1.1)</div>
            <div>Batch Header: 16 bytes (magic: 0xABCD1234)</div>
            <div>Audio Frame: 1,932 bytes × 4 frames</div>
            <div>Frame Layout: seq(4) + vad(4) + rms(4) + raw_pcm(960) + clean_pcm(960)</div>
            <div>Last Received: Batch #{connectionStatus.lastBatchSeq || 'N/A'}</div>
            <div>Total Packets: {connectionStatus.packetsReceived}</div>
            <div>Avg Latency: {connectionStatus.averageLatency.toFixed(1)}ms</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
