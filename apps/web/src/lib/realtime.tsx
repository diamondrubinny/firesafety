import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AlarmCategory } from '@firesafety/shared';
import { useAuth } from './auth';

interface LiveState {
  connected: boolean;
  /** Increments on every server notification that included a fire category. */
  fireSignal: number;
}

const LiveContext = createContext<LiveState>({ connected: false, fireSignal: 0 });

/**
 * WebSocket that only tells us *that* something changed; data is re-fetched via REST.
 * Reconnects with exponential backoff and refetches everything after a reconnect.
 */
export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const [connected, setConnected] = useState(false);
  const [fireSignal, setFireSignal] = useState(0);
  const retry = useRef(0);

  useEffect(() => {
    if (!me) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const refreshAll = () => {
      void qc.invalidateQueries({ queryKey: ['alarms'] });
      void qc.invalidateQueries({ queryKey: ['system-status'] });
    };

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
      ws.onopen = () => {
        retry.current = 0;
        setConnected(true);
        refreshAll();
      };
      ws.onmessage = (e) => {
        let msg: { type?: string; categories?: AlarmCategory[] };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === 'alarms') {
          void qc.invalidateQueries({ queryKey: ['alarms'] });
          if (msg.categories?.includes('fire')) setFireSignal((n) => n + 1);
        } else if (msg.type === 'status') {
          refreshAll();
        }
      };
      ws.onclose = (e) => {
        setConnected(false);
        if (stopped) return;
        if (e.code === 4401) {
          // Session ended on the server.
          void qc.invalidateQueries({ queryKey: ['me'] });
          return;
        }
        const delay = Math.min(30_000, 1000 * 2 ** retry.current++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [me, qc]);

  return <LiveContext.Provider value={{ connected, fireSignal }}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
