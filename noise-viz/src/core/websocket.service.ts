// src/core/websocket.service.ts
import { useEffect, useRef, useState } from 'react';
import { AudioBatchDTO } from './dto.types';

const WS_URL = 'ws://localhost:8080'; // ← double-check this matches your server

export function useWebSocketData() {
  const [data, setData] = useState<AudioBatchDTO | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected ✅');
      setIsConnected(true);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as AudioBatchDTO;
        setData(parsed);
      } catch (err) {
        console.warn('Invalid JSON from server:', err);
      }
    };

    ws.onclose = (e) => {
      console.log('WebSocket closed', e.code, e.reason);
      setIsConnected(false);

      // Auto-reconnect after 2 seconds (avoid spam)
      if (!reconnectTimeoutRef.current) {
        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    wsRef.current = ws;
  };

  useEffect(() => {
    connect();

    // Cleanup on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  return { data, isConnected };
}
