import React, { useEffect, useRef, useState } from 'react';
import { WebSocketService } from '../core/websocket.service';
import { VisualizationDTO } from '../core/dto.types';
import { WaveformRenderer } from '../features/waveform/waveform.renderer';
import { SpectrumRenderer } from '../features/spectrum/spectrum.renderer';
import { VADHistoryRenderer } from '../features/vad-history/vad-history.renderer';
import { MetricsPanel } from '../features/metrics/metrics.component';

const WS_URL = 'ws://localhost:8080/visualizer';

export const AudioDashboard: React.FC = () => {
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const vadHistoryRef = useRef<HTMLCanvasElement>(null);

  const waveformRenderer = useRef<WaveformRenderer | null>(null);
  const spectrumRenderer = useRef<SpectrumRenderer | null>(null);
  const vadHistoryRenderer = useRef<VADHistoryRenderer | null>(null);
  const wsService = useRef<WebSocketService | null>(null);

  const [connected, setConnected] = useState(false);
  const [dto, setDto] = useState<VisualizationDTO | null>(null);
  const [gain, setGain] = useState(1.0);
  const [autoScale, setAutoScale] = useState(true);

  // Initialize renderers
  useEffect(() => {
    if (waveformRef.current && !waveformRenderer.current) {
      waveformRenderer.current = new WaveformRenderer(waveformRef.current);
    }
    if (spectrumRef.current && !spectrumRenderer.current) {
      spectrumRenderer.current = new SpectrumRenderer(spectrumRef.current);
    }
    if (vadHistoryRef.current && !vadHistoryRenderer.current) {
      vadHistoryRenderer.current = new VADHistoryRenderer(vadHistoryRef.current);
    }
  }, []);

  // Update renderer settings
  useEffect(() => {
    if (waveformRenderer.current) {
      waveformRenderer.current.setGain(gain);
      waveformRenderer.current.setAutoScale(autoScale);
    }
  }, [gain, autoScale]);

  // Setup WebSocket
  useEffect(() => {
    wsService.current = new WebSocketService(
      WS_URL,
      (newDto) => {
        setDto(newDto);
        vadHistoryRenderer.current?.addValue(newDto.vad);
      },
      setConnected
    );

    wsService.current.connect();

    return () => {
      wsService.current?.disconnect();
    };
  }, []);

  // Render loop using requestAnimationFrame
  useEffect(() => {
    let animationId: number;

    const render = () => {
      if (dto) {
        waveformRenderer.current?.render(dto.rawWaveform, dto.cleanWaveform);
        spectrumRenderer.current?.render(dto.rawSpectrum, dto.cleanSpectrum);
        vadHistoryRenderer.current?.render();
      }
      animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [dto]);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>🔊 ESP32-S3 Audio Visualizer</h1>
        <div style={styles.subtitle}>Real-time RNNoise Denoising Monitor | 48kHz | 40ms window</div>
      </header>

      <MetricsPanel
        vad={dto?.vad ?? 0}
        snr={dto?.snr ?? 0}
        latencyMs={dto?.latencyMs ?? 0}
        packetLoss={dto?.packetLoss ?? 0}
        batchSeq={dto?.batchSeq ?? 0}
        peakRaw={dto?.peak_raw ?? 0}
        rmsDb={dto?.rms_db ?? -60}
        voiceDetected={dto?.voice_detected ?? false}
        connected={connected}
      />

      {/* Gain Control Panel */}
      <div style={styles.controls}>
        <label style={styles.controlLabel}>
          <input
            type="checkbox"
            checked={autoScale}
            onChange={(e) => setAutoScale(e.target.checked)}
            style={styles.checkbox}
          />
          <span>Auto-scale (recommended for voice)</span>
        </label>

        {!autoScale && (
          <div style={styles.gainControl}>
            <span style={styles.gainLabel}>Manual Gain: {gain.toFixed(1)}x</span>
            <input
              type="range"
              min="0.1"
              max="50"
              step="0.5"
              value={gain}
              onChange={(e) => setGain(parseFloat(e.target.value))}
              style={styles.slider}
            />
            <span style={styles.gainHint}>Use 10-30x for quiet voice</span>
          </div>
        )}
      </div>

      <div style={styles.visualizationContainer}>
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Waveform</span>
            <span style={styles.sectionSubtitle}>
              Time: 0-40ms | Amplitude: Auto-scaled to fill view
            </span>
          </div>
          <canvas
            ref={waveformRef}
            style={styles.canvas}
          />
        </div>

        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Frequency Spectrum</span>
            <span style={styles.sectionSubtitle}>0-24kHz | Log magnitude scale</span>
          </div>
          <canvas
            ref={spectrumRef}
            style={styles.canvas}
          />
        </div>

        <div style={styles.vadSection}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Voice Activity History</span>
            <span style={styles.sectionSubtitle}>Last 4 seconds</span>
          </div>
          <canvas
            ref={vadHistoryRef}
            style={{...styles.canvas, height: '60px'}}
          />
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#000',
    color: '#fff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    padding: '20px',
    backgroundColor: '#0a0a0a',
    borderBottom: '1px solid #333',
    textAlign: 'center',
  },
  title: {
    margin: 0,
    fontSize: '24px',
    fontWeight: 'bold',
    background: 'linear-gradient(90deg, #00ff88, #00aaff)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  subtitle: {
    color: '#666',
    fontSize: '14px',
    marginTop: '5px',
  },
  controls: {
    display: 'flex',
    gap: '30px',
    padding: '12px 20px',
    backgroundColor: '#141414',
    borderBottom: '1px solid #333',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  controlLabel: {
    color: '#aaa',
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  checkbox: {
    cursor: 'pointer',
  },
  gainControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    color: '#aaa',
    fontSize: '13px',
  },
  gainLabel: {
    color: '#00ff88',
    fontWeight: 'bold',
    minWidth: '100px',
  },
  slider: {
    width: '200px',
    cursor: 'pointer',
  },
  gainHint: {
    color: '#666',
    fontSize: '11px',
    fontStyle: 'italic',
  },
  visualizationContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '20px',
    gap: '20px',
    overflow: 'auto',
  },
  section: {
    backgroundColor: '#0a0a0a',
    borderRadius: '8px',
    border: '1px solid #333',
    overflow: 'hidden',
    flex: 1,
    minHeight: '200px',
    display: 'flex',
    flexDirection: 'column',
  },
  vadSection: {
    backgroundColor: '#0a0a0a',
    borderRadius: '8px',
    border: '1px solid #333',
    overflow: 'hidden',
    height: '80px',
  },
  sectionHeader: {
    padding: '10px 15px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #333',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: '1px',
  },
  sectionSubtitle: {
    fontSize: '11px',
    color: '#666',
    fontFamily: 'monospace',
  },
  canvas: {
    width: '100%',
    height: '100%',
    display: 'block',
  },
};
