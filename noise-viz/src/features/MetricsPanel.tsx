// src/features/MetricsPanel.tsx
import { AudioBatchDTO } from '../core/dto.types';

interface Props {
  data: AudioBatchDTO | null;
}

export default function MetricsPanel({ data }: Props) {
  if (!data) return <div>Waiting for data...</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, padding: 16, background: '#222', borderRadius: 8 }}>
      <div>
        <strong>Batch</strong><br />
        {data.batchSeq}
      </div>
      <div>
        <strong>Latency</strong><br />
        {data.latencyMs} ms
      </div>
      <div>
        <strong>SNR</strong><br />
        {data.snr.toFixed(1)} dB
      </div>
      <div>
        <strong>VAD Prob</strong><br />
        {(data.vad * 100).toFixed(0)}%
      </div>
      <div>
        <strong>Packet Loss</strong><br />
        {data.packetLoss}%
      </div>
    </div>
  );
}
