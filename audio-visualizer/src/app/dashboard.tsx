// src/app/dashboard.tsx
//
// DTO ADDITION REQUIRED — add this block to src/core/dto.types.ts:
//
//   melSpectrogram: {
//     raw:     number[];  // 40 mel-band energy values (linear or dB)
//     clean:   number[];  // 40 mel-band energy values
//     melBins: number;    // 40
//     fMin:    number;    // lowest mel freq (Hz)  — e.g. 20
//     fMax:    number;    // highest mel freq (Hz) — e.g. 8000
//   };
//
// If your server sends dB already, pass  isLogScaled: true  to the renderer
// constructors below (~line 60).
//
import React, { useEffect, useRef, useState } from 'react';
import { WebSocketService } from '../core/websocket.service';
import { VisualizationDTO } from '../core/dto.types';
import { WaveformRenderer } from '../features/waveform/waveform.renderer';
import { SpectrumRenderer } from '../features/spectrum/spectrum.renderer';
import { BarkBandsRenderer } from '../features/bark-bands/bark-bands.renderer';
import { VADHistoryRenderer } from '../features/vad-history/vad-history.renderer';
import { MetricsPanel } from '../features/metrics/metrics.component';
import { MelSpectrogramRenderer } from '../features/mel-spectrogram/mel-spectrogram.renderer';

const WS_URL = 'ws://localhost:8080/visualizer';

export const AudioDashboard: React.FC = () => {
  // ── canvas refs ──────────────────────────────────────────────────────────
  const waveformRef    = useRef<HTMLCanvasElement>(null);
  const spectrumRef    = useRef<HTMLCanvasElement>(null);
  const barkBandsRef   = useRef<HTMLCanvasElement>(null);
  const vadHistoryRef  = useRef<HTMLCanvasElement>(null);
  const melRawRef      = useRef<HTMLCanvasElement>(null);
  const melCleanRef    = useRef<HTMLCanvasElement>(null);

  // ── renderer refs ─────────────────────────────────────────────────────────
  const waveformRenderer   = useRef<WaveformRenderer | null>(null);
  const spectrumRenderer   = useRef<SpectrumRenderer | null>(null);
  const barkBandsRenderer  = useRef<BarkBandsRenderer | null>(null);
  const vadHistoryRenderer = useRef<VADHistoryRenderer | null>(null);
  const melRawRenderer     = useRef<MelSpectrogramRenderer | null>(null);
  const melCleanRenderer   = useRef<MelSpectrogramRenderer | null>(null);
  const wsService          = useRef<WebSocketService | null>(null);

  const [connected, setConnected] = useState(false);
  const [dto, setDto]     = useState<VisualizationDTO | null>(null);
  const [gain, setGain]   = useState(1.0);
  const [autoScale, setAutoScale] = useState(true);

  // ── initialise renderers once canvases are mounted ────────────────────────
  useEffect(() => {
    if (waveformRef.current && !waveformRenderer.current)
      waveformRenderer.current = new WaveformRenderer(waveformRef.current);

    if (spectrumRef.current && !spectrumRenderer.current)
      spectrumRenderer.current = new SpectrumRenderer(spectrumRef.current);

    if (barkBandsRef.current && !barkBandsRenderer.current)
      barkBandsRenderer.current = new BarkBandsRenderer(barkBandsRef.current);

    if (vadHistoryRef.current && !vadHistoryRenderer.current)
      vadHistoryRenderer.current = new VADHistoryRenderer(vadHistoryRef.current);

    // Mel spectrogram renderers
    // Server sends log-mel / dB values directly — no conversion needed
    if (melRawRef.current && !melRawRenderer.current)
      melRawRenderer.current = new MelSpectrogramRenderer(melRawRef.current, {
        melBins: 40, historyFrames: 200, isLogScaled: true,
      });

    if (melCleanRef.current && !melCleanRenderer.current)
      melCleanRenderer.current = new MelSpectrogramRenderer(melCleanRef.current, {
        melBins: 40, historyFrames: 200, isLogScaled: true,
      });
  }, []);

  // ── sync gain / auto-scale to waveform renderer ───────────────────────────
  useEffect(() => {
    if (waveformRenderer.current) {
      waveformRenderer.current.setGain(gain);
      waveformRenderer.current.setAutoScale(autoScale);
    }
  }, [gain, autoScale]);

  // ── WebSocket: connect + feed data ────────────────────────────────────────
  useEffect(() => {
    wsService.current = new WebSocketService(
      WS_URL,
      (newDto) => {
        setDto(newDto);
        vadHistoryRenderer.current?.addValue(newDto.vad);

        // Feed mel frames as they arrive (outside rAF loop for accurate timing)
        // Guard: field is optional until server deploys v1.2
        if (newDto.melSpectrogram) {
          melRawRenderer.current?.addFrame(newDto.melSpectrogram.raw);
          melCleanRenderer.current?.addFrame(newDto.melSpectrogram.clean);
        }
      },
      setConnected,
    );

    wsService.current.connect();
    return () => wsService.current?.disconnect();
  }, []);

  // ── rAF render loop ───────────────────────────────────────────────────────
  useEffect(() => {
    let animationId: number;

    const render = () => {
      if (dto) {
        waveformRenderer.current?.render(
          dto.waveform.raw, dto.waveform.clean,
          dto.waveform.sampleRate, dto.waveform.durationMs,
        );
        spectrumRenderer.current?.render(
          dto.spectrum.raw, dto.spectrum.clean,
          dto.spectrum.frequencies, dto.waveform.sampleRate, dto.spectrum.fftSize,
        );
        barkBandsRenderer.current?.render(
          dto.barkBands.raw, dto.barkBands.clean,
          dto.barkBands.bandEdges, dto.waveform.sampleRate,
        );
        vadHistoryRenderer.current?.render();

        // Mel spectrograms: render every frame (data is pushed in WS callback)
        melRawRenderer.current?.render('RAW MEL');
        melCleanRenderer.current?.render('CLEAN MEL');
      }
      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [dto]);

  // ── helpers ───────────────────────────────────────────────────────────────
  const sampleRate = dto?.waveform?.sampleRate ?? 48000;
  const melMeta = dto?.melSpectrogram;

  return (
    <div style={styles.container}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header style={styles.header}>
        <h1 style={styles.title}>🔊 ESP32-S3 Audio Visualizer</h1>
        <div style={styles.subtitle}>
          Real-time Audio Monitoring | {sampleRate.toLocaleString()} Hz | 16-bit PCM
        </div>
      </header>

      {/* ── Metrics ────────────────────────────────────────────────────── */}
      <MetricsPanel
        batchSeq={dto?.batchSeq ?? 0}
        timestampMs={dto?.timestampMs ?? 0}
        latencyMs={dto?.latencyMs ?? 0}
        snr={dto?.snr ?? 0}
        vad={dto?.vad ?? 0}
        rmsRaw={dto?.rmsRaw ?? 0}
        packetLoss={dto?.packetLoss ?? 0}
        totalPacketLoss={dto?.totalPacketLoss}
        connectionStatus={dto?.connectionStatus ?? 'offline'}
        frameSeq={dto?.system?.frameSeq ?? 0}
        serverProcessingMs={dto?.system?.serverProcessingMs ?? 0}
        queueDepth={dto?.system?.queueDepth ?? 0}
        sampleRate={sampleRate}
        connected={connected}
      />

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div style={styles.controls}>
        <label style={styles.controlLabel}>
          <input
            type="checkbox"
            checked={autoScale}
            onChange={(e) => setAutoScale(e.target.checked)}
            style={styles.checkbox}
          />
          <span>Auto-scale waveform</span>
        </label>

        {!autoScale && (
          <div style={styles.gainControl}>
            <span style={styles.gainLabel}>Manual Gain: {gain.toFixed(1)}x</span>
            <input
              type="range" min="0.1" max="50" step="0.5" value={gain}
              onChange={(e) => setGain(parseFloat(e.target.value))}
              style={styles.slider}
            />
            <span style={styles.gainHint}>Use 10-30x for quiet voice</span>
          </div>
        )}
      </div>

      {/* ── Visualizations ─────────────────────────────────────────────── */}
      <div style={styles.visualizationContainer}>

        {/* Waveform */}
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Waveform</span>
            <span style={styles.sectionSubtitle}>
              {dto?.waveform
                ? `${dto.waveform.durationMs}ms window @ fs=${dto.waveform.sampleRate / 1000}kHz`
                : 'Waiting…'}
            </span>
          </div>
          <canvas ref={waveformRef} style={styles.canvas} />
        </div>

        {/* Frequency Spectrum */}
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Frequency Spectrum</span>
            <span style={styles.sectionSubtitle}>
              {dto?.spectrum
                ? `FFT-${dto.spectrum.fftSize} | 0–${dto.waveform.sampleRate / 2000}kHz | fs=${dto.waveform.sampleRate / 1000}kHz`
                : 'Waiting…'}
            </span>
          </div>
          <canvas ref={spectrumRef} style={styles.canvas} />
        </div>

        {/* Bark Bands */}
        <div style={styles.halfSection}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Bark Bands</span>
            <span style={styles.sectionSubtitle}>
              {dto?.barkBands
                ? `24 bands | fs=${dto.waveform.sampleRate / 1000}kHz`
                : 'Waiting…'}
            </span>
          </div>
          <canvas ref={barkBandsRef} style={styles.canvas} />
        </div>

        {/* VAD History */}
        <div style={styles.vadSection}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Voice Activity History</span>
            <span style={styles.sectionSubtitle}>Last 4 seconds</span>
          </div>
          <canvas ref={vadHistoryRef} style={{ ...styles.canvas, height: '60px' }} />
        </div>

        {/* ── MEL SPECTROGRAM: RAW ─────────────────────────────────────── */}
        <div style={styles.melSection}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>
              <span style={styles.rawDot} /> Mel Spectrogram — Raw
            </span>
            <span style={styles.sectionSubtitle}>
              {melMeta
                ? `40 bins | ${melMeta.fMin}–${melMeta.fMax} Hz | 8s history | inferno scale`
                : '40 bins | 8s history | inferno scale'}
            </span>
          </div>
          <div style={styles.melCanvasWrapper}>
            <canvas ref={melRawRef} style={styles.melCanvas} />
          </div>
        </div>

        {/* ── MEL SPECTROGRAM: CLEAN ───────────────────────────────────── */}
        <div style={styles.melSection}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>
              <span style={styles.cleanDot} /> Mel Spectrogram — Clean
            </span>
            <span style={styles.sectionSubtitle}>
              {melMeta
                ? `40 bins | ${melMeta.fMin}–${melMeta.fMax} Hz | 8s history | inferno scale`
                : '40 bins | 8s history | inferno scale'}
            </span>
          </div>
          <div style={styles.melCanvasWrapper}>
            <canvas ref={melCleanRef} style={styles.melCanvas} />
          </div>
        </div>

      </div>
    </div>
  );
};

// ── Styles ──────────────────────────────────────────────────────────────────
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
    fontSize: '13px',
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
  checkbox: { cursor: 'pointer' },
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
    minWidth: '120px',
  },
  slider: { width: '200px', cursor: 'pointer' },
  gainHint: { color: '#666', fontSize: '11px', fontStyle: 'italic' },

  // ── visualization grid ──────────────────────────────────────────────────
  visualizationContainer: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr auto auto auto',
    gap: '15px',
    padding: '15px',
    overflow: 'auto',
  },
  section: {
    backgroundColor: '#0a0a0a',
    borderRadius: '8px',
    border: '1px solid #333',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '200px',
  },
  halfSection: {
    backgroundColor: '#0a0a0a',
    borderRadius: '8px',
    border: '1px solid #333',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '150px',
  },
  vadSection: {
    backgroundColor: '#0a0a0a',
    borderRadius: '8px',
    border: '1px solid #333',
    overflow: 'hidden',
    height: '80px',
    gridColumn: '1 / -1',
  },

  // ── mel spectrogram sections ────────────────────────────────────────────
  melSection: {
    backgroundColor: '#0a0a0a',
    borderRadius: '8px',
    border: '1px solid #2a2a2a',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  melCanvasWrapper: {
    flex: 1,
    position: 'relative',
    minHeight: '160px',
  },
  melCanvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    imageRendering: 'pixelated', // keep pixel-art crispness when scaled
  },

  // ── shared panel header ─────────────────────────────────────────────────
  sectionHeader: {
    padding: '8px 12px',
    backgroundColor: '#1a1a1a',
    borderBottom: '1px solid #333',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 'bold',
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  sectionSubtitle: {
    fontSize: '10px',
    color: '#00ff88',
    fontFamily: 'monospace',
  },
  canvas: {
    width: '100%',
    height: '100%',
    display: 'block',
    flex: 1,
  },

  // ── coloured channel dots ───────────────────────────────────────────────
  rawDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#ff4444',
    flexShrink: 0,
  },
  cleanDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#00ff88',
    flexShrink: 0,
  },
};
