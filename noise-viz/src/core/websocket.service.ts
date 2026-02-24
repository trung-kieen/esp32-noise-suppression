// src/core/websocket.service.ts
// WebSocket service for connecting to Python server at ws://localhost:8080

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: (data: AudioDTO) => void;
  private onStatusChange: (status: ConnectionStatus) => void;
  private reconnectInterval: number = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private status: ConnectionStatus = {
    connected: false,
    lastBatchSeq: null,
    packetsReceived: 0,
    packetsLost: 0,
    averageLatency: 0,
  };

  constructor(
    url: string = 'ws://localhost:8080',
    onMessage: (data: AudioDTO) => void,
    onStatusChange: (status: ConnectionStatus) => void
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect(): void {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.status.connected = true;
        this.onStatusChange({ ...this.status });
      };

      this.ws.onmessage = (event) => {
        try {
          const dto: AudioDTO = JSON.parse(event.data);
          this.status.packetsReceived++;
          this.status.lastBatchSeq = dto.batchSeq;

          // Detect packet loss based on sequence gaps
          if (this.status.lastBatchSeq !== null) {
            const expectedSeq = this.status.lastBatchSeq + 1;
            if (dto.batchSeq > expectedSeq) {
              this.status.packetsLost += dto.batchSeq - expectedSeq;
            }
          }

          // Update average latency
          this.status.averageLatency =
            (this.status.averageLatency * (this.status.packetsReceived - 1) + dto.latencyMs)
            / this.status.packetsReceived;

          this.onMessage(dto);
          this.onStatusChange({ ...this.status });
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.status.connected = false;
        this.onStatusChange({ ...this.status });
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.status.connected = false;
        this.onStatusChange({ ...this.status });
      };
    } catch (e) {
      console.error('Failed to create WebSocket:', e);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export interface AudioDTO {
  batchSeq: number;
  latencyMs: number;
  snr: number;
  vad: number;
  packetLoss: number;
  rawSpectrum: number[];
  cleanSpectrum: number[];
  rawWaveform: number[];
  cleanWaveform: number[];
}

export interface ConnectionStatus {
  connected: boolean;
  lastBatchSeq: number | null;
  packetsReceived: number;
  packetsLost: number;
  averageLatency: number;
}
