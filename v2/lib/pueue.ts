const BACKEND_URL = process.env.PUEUE_V2_BACKEND_URL ?? "http://127.0.0.1:9093";

async function backendFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Backend request failed (${response.status})`);
  }

  return response.json();
}

export async function getStatus(): Promise<Record<string, unknown>> {
  return backendFetch("/status");
}

export async function getLog(taskId: string): Promise<unknown> {
  const payload = await backendFetch(`/logs/${taskId}`);
  return payload.log as unknown;
}

export async function getCallbackConfig(): Promise<Record<string, unknown>> {
  return backendFetch("/config/callback");
}

export async function updateCallbackConfig(body: {
  callback?: string;
  callback_log_lines?: number;
}): Promise<Record<string, unknown>> {
  return backendFetch("/config/callback", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const allowedActions = new Set([
  "start",
  "restart",
  "pause",
  "resume",
  "kill",
  "remove",
]);

export async function runAction(taskId: string, action: string) {
  if (!allowedActions.has(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }

  const payload = await backendFetch(`/task/${taskId}`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });

  return payload.result as unknown;
}
