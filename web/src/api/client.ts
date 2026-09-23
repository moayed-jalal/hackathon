const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const STORAGE_KEY = "finbridge_sandbox_api_key";

export function getApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) ?? (import.meta.env.VITE_DEMO_API_KEY as string | undefined) ?? "";
}

export function setApiKey(key: string) {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, options: { useSession?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  if (!options.useSession) {
    const apiKey = getApiKey();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: options.useSession ? "include" : "omit",
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = json?.error ?? { code: "UNKNOWN_ERROR", message: response.statusText };
    throw new ApiError(response.status, err.code, err.message, json?.request_id, err.details);
  }

  return json as T;
}

export const api = {
  get: <T>(path: string, useSession = false) => request<T>(path, {}, { useSession }),
  post: <T>(path: string, body?: unknown, useSession = false, headers?: Record<string, string>) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers }, { useSession }),
  del: <T>(path: string, useSession = false) => request<T>(path, { method: "DELETE" }, { useSession }),
};

export const consoleApi = {
  get: <T>(path: string) => request<T>(path, {}, { useSession: true }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers }, { useSession: true }),
  put: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined, headers }, { useSession: true }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }, { useSession: true }),
};

export { BASE_URL };