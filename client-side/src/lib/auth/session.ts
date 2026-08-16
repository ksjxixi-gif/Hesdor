import type { Session } from "@/types/api";

const SESSION_KEY = "hesdor.session";
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSession(): Session | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedSession = window.sessionStorage.getItem(SESSION_KEY);
  if (!storedSession) {
    return null;
  }

  try {
    return JSON.parse(storedSession) as Session;
  } catch {
    window.sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function saveSession(session: Session) {
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  notify();
}

export function clearSession() {
  window.sessionStorage.removeItem(SESSION_KEY);
  notify();
}
