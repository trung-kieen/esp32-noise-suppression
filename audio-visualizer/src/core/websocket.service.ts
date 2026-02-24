import { VisualizationDTO } from "./dto.types";

// src/core/websocket.service.ts
export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: (dto: VisualizationDTO) => void;
  private onStatusChange: (connected: boolean) => void;
  private reconnectInterval: number = 3000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private latestDto: VisualizationDTO | null = null;

  constructor(
    url: string,
    onMessage: (dto: VisualizationDTO) => void,
    onStatusChange: (connected: boolean) => void
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect(): void {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('WebSocket connected to visualizer');
        this.onStatusChange(true);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const dto: VisualizationDTO = JSON.parse(event.data);
          this.latestDto = dto;
          this.onMessage(dto);
        } catch (err) {
          console.error('Failed to parse DTO:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.onStatusChange(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        this.ws?.close();
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        console.log('Attempting to reconnect...');
        this.connect();
      }, this.reconnectInterval);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
  }

  getLatestDto(): VisualizationDTO | null {
    return this.latestDto;
  }
}
