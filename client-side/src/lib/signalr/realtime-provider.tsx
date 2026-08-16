"use client";

import { HubConnectionBuilder, LogLevel, type HubConnection } from "@microsoft/signalr";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/auth-provider";

type RealtimeContextValue = {
  isConfigured: boolean;
  subscribe: (eventName: string, handler: (...args: unknown[]) => void) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);
const HUB_URL = process.env.NEXT_PUBLIC_SIGNALR_HUB_URL;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const connectionRef = useRef<HubConnection | null>(null);

  useEffect(() => {
    if (!session || !HUB_URL) {
      return;
    }

    const connection = new HubConnectionBuilder()
      .withUrl(HUB_URL, { accessTokenFactory: () => session.accessToken })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();

    connectionRef.current = connection;
    void connection.start().catch(() => undefined);

    return () => {
      connectionRef.current = null;
      void connection.stop();
    };
  }, [session]);

  const value: RealtimeContextValue = {
    isConfigured: Boolean(HUB_URL),
    subscribe: (eventName, handler) => {
      const connection = connectionRef.current;
      if (!connection) {
        return () => undefined;
      }

      connection.on(eventName, handler);
      return () => connection.off(eventName, handler);
    },
  };

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error("useRealtime must be used within RealtimeProvider.");
  }
  return context;
}
