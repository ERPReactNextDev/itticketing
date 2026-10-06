/**
 * Typed fetch wrapper for the app's API routes.
 *
 * Every call goes through here so error handling is uniform: the API returns
 * `{ error, message }`, and callers get a thrown `ApiError` with that message
 * rather than having to inspect response shapes.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;

  constructor(message: string, status: number, code = "error", field?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};

  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    // Always send the session cookie.
    credentials: "same-origin",
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      (isJson && typeof payload === "object" && payload && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : "") || `Request failed (${response.status})`;
    const code = isJson && typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error?: unknown }).error)
      : "error";
    const field =
      isJson && typeof payload === "object" && payload && "field" in payload
        ? String((payload as { field?: unknown }).field)
        : undefined;
    throw new ApiError(message, response.status, code, field);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: "POST", json }),
  patch: <T>(path: string, json?: unknown) => request<T>(path, { method: "PATCH", json }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: "PUT", json }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** Triggers a browser download for a CSV endpoint. */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    throw new ApiError("Could not generate the export.", response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}