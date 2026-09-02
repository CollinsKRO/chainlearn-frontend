import { ApiError, ApiResponse } from "@/types/api";
import { useAuthStore } from "@/store/auth-store";
import { useErrorStore } from "@/store/error-store";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_RETRIES = 3;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 100;

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

const responseCache = new Map<string, CacheEntry>();

/**
 * In-flight GET requests keyed by cache key. Concurrent callers asking for the
 * same resource share one network request (and its retries) instead of each
 * firing their own. The shared request is owned by an internal AbortController
 * that is aborted only once every caller has detached, so no single consumer
 * unmounting can cancel a request others are still waiting on.
 */
type InFlightEntry = {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
  settled: boolean;
};

const inFlightGets = new Map<string, InFlightEntry>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rejects with an AbortError as soon as `signal` fires, otherwise settles with
 * `promise`. Lets a caller stop awaiting a shared request without cancelling
 * the underlying request for other callers.
 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * Builds the error `fetch` throws when its signal fires, so callers can detect
 * a manually cancelled request via `error.name === "AbortError"` and skip any
 * state updates.
 */
function createAbortError(): Error {
  return new DOMException("The request was aborted.", "AbortError");
}

/**
 * Returns true when the error was caused by an AbortController signal firing,
 * either internally (timeout) or externally (manual cancellation).
 *
 * `fetch` rejects with a DOMException named "AbortError", which is not an
 * `instanceof Error`, so the check inspects the `name` rather than the type.
 */
export function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private getHeaders(jwt?: string): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (jwt) {
      headers["Authorization"] = `Bearer ${jwt}`;
    }
    return headers;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      if (response.status === 401) {
        useAuthStore.getState().disconnect();
      }
      const errorBody = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        errorBody.message || response.statusText,
        errorBody.code
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private isTransientError(error: Error): boolean {
    if (error instanceof ApiError) {
      return error.code === "TIMEOUT" || error.code === "NETWORK_ERROR";
    }
    return false;
  }

  /**
   * Runs fetch with a request timeout and retries on transient failures with
   * exponential backoff (1s, 2s, 4s) up to `retries` attempts. GET retries on
   * 5xx responses and network errors; 4xx responses are never retried.
   * Mutations pass 0 retries since a failed connection doesn't guarantee the
   * server never received the request, and writes are generally not idempotent.
   *
   * An optional external signal (typically an AbortController created by a
   * hook's cleanup) cancels the in-flight request immediately. External
   * aborts never retry and surface an AbortError so callers can ignore the
   * result after unmounting.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries: number,
    signal?: AbortSignal,
    timeout: number = REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      const onExternalAbort = () => controller.abort();
      signal?.addEventListener("abort", onExternalAbort);

      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });

        if (response.status < 500 || attempt >= retries) {
          return response;
        }

        console.warn(
          `API request to ${url} returned ${response.status}; retrying (${attempt + 1}/${retries})`
        );
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
      } catch (error) {
        if (signal?.aborted) {
          throw createAbortError();
        }

        const isTimeout = isAbortError(error);
        const isNetworkError = error instanceof TypeError;

        if (!isTimeout && !isNetworkError) {
          throw error;
        }
        if (attempt >= retries) {
          throw isTimeout
            ? new ApiError(0, "Request timed out", "TIMEOUT")
            : new ApiError(
                0,
                "Unable to reach the server. Check your connection.",
                "NETWORK_ERROR"
              );
        }
        console.warn(
          `API request to ${url} failed; retrying (${attempt + 1}/${retries})`
        );
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  private handleApiError(error: ApiError): void {
    const isTransient = this.isTransientError(error);
    useErrorStore.getState().setError(error, isTransient);
  }

  private cacheKey(url: string, jwt?: string): string {
    return jwt ? `${url}|${jwt}` : url;
  }

  private getCached<T>(key: string): T | undefined {
    const entry = responseCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      responseCache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private setCached<T>(key: string, value: T): void {
    if (responseCache.size >= CACHE_MAX_SIZE) {
      const oldest = responseCache.keys().next().value;
      if (oldest !== undefined) {
        responseCache.delete(oldest);
      }
    }
    responseCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private invalidateCache(): void {
    responseCache.clear();
    // Stop new callers from joining requests that started before this
    // mutation; those already in flight still resolve for their awaiters.
    inFlightGets.clear();
  }

  async get<T>(
    path: string,
    jwt?: string,
    signal?: AbortSignal,
    options?: { bypassCache?: boolean; timeout?: number }
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const key = this.cacheKey(url, jwt);

    if (!options?.bypassCache) {
      const cached = this.getCached<ApiResponse<T>>(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    if (signal?.aborted) {
      throw createAbortError();
    }

    // A `bypassCache` read is deliberately never shared: the caller wants its
    // own fresh round-trip and owns cancellation directly.
    if (options?.bypassCache) {
      return this.executeGet<T>(url, key, jwt, true, signal, options?.timeout);
    }

    let entry = inFlightGets.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: InFlightEntry = {
        controller,
        refs: 0,
        settled: false,
        promise: this.executeGet<T>(url, key, jwt, false, controller.signal, options?.timeout),
      };
      const settle = () => {
        created.settled = true;
        if (inFlightGets.get(key) === created) {
          inFlightGets.delete(key);
        }
      };
      created.promise.then(settle, settle);
      inFlightGets.set(key, created);
      entry = created;
    }

    entry.refs++;
    try {
      return (await withAbort(entry.promise, signal)) as ApiResponse<T>;
    } finally {
      entry.refs--;
      // Last caller gone before the request finished — cancel it for real.
      if (entry.refs <= 0 && !entry.settled) {
        entry.controller.abort();
      }
    }
  }

  private async executeGet<T>(
    url: string,
    key: string,
    jwt: string | undefined,
    bypassCache: boolean,
    signal?: AbortSignal,
    timeout?: number
  ): Promise<ApiResponse<T>> {
    try {
      const response = await this.fetchWithRetry(
        url,
        { method: "GET", headers: this.getHeaders(jwt) },
        MAX_RETRIES,
        signal,
        timeout
      );
      const data = await this.handleResponse<ApiResponse<T>>(response);
      if (!bypassCache) {
        this.setCached(key, data);
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        this.handleApiError(error);
      }
      throw error;
    }
  }

  async post<T>(
    path: string,
    body: unknown,
    jwt?: string,
    signal?: AbortSignal,
    timeout?: number
  ): Promise<ApiResponse<T>> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: this.getHeaders(jwt),
          body: JSON.stringify(body),
        },
        0,
        signal,
        timeout
      );
      const data = await this.handleResponse<ApiResponse<T>>(response);
      this.invalidateCache();
      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        this.handleApiError(error);
      }
      throw error;
    }
  }

  async put<T>(
    path: string,
    body: unknown,
    jwt?: string,
    signal?: AbortSignal,
    timeout?: number
  ): Promise<ApiResponse<T>> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}${path}`,
        {
          method: "PUT",
          headers: this.getHeaders(jwt),
          body: JSON.stringify(body),
        },
        0,
        signal,
        timeout
      );
      const data = await this.handleResponse<ApiResponse<T>>(response);
      this.invalidateCache();
      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        this.handleApiError(error);
      }
      throw error;
    }
  }

  async delete<T>(
    path: string,
    jwt?: string,
    signal?: AbortSignal,
    timeout?: number
  ): Promise<ApiResponse<T>> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}${path}`,
        { method: "DELETE", headers: this.getHeaders(jwt) },
        0,
        signal,
        timeout
      );
      const data = await this.handleResponse<ApiResponse<T>>(response);
      this.invalidateCache();
      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        this.handleApiError(error);
      }
      throw error;
    }
  }
}

export const apiClient = new ApiClient(BASE_URL);
