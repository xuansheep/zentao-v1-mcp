import type { ZentaoConfig } from "../config.js";
import {
  ImageUploadAuthRejectedError,
  ImageUploadAuthService,
  type ImageUploadAuthContext,
  type ImageUploadAuthExecutor,
  type ImageUploadAuthInfo,
  type ImageUploadAuthResult,
} from "./imageUploadAuth.js";

export type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ZentaoRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

export type ZentaoPasteImageRequest = {
  endpoint: string;
  editorHtml: string;
};

type TextResponse = {
  ok: boolean;
  status: number;
  body: string;
  headers: Headers;
};

export class ZentaoHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly responseBody: unknown;

  constructor(input: { status: number; path: string; responseBody: unknown }) {
    super(`ZenTao request failed: ${input.status} ${input.path}`);
    this.status = input.status;
    this.path = input.path;
    this.responseBody = redactSecrets(input.responseBody);
  }
}

export class ZentaoClient {
  private readonly config: ZentaoConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly imageUploadAuth: ImageUploadAuthExecutor;
  private token: string | undefined;

  constructor(input: {
    config: ZentaoConfig;
    fetchImpl?: FetchImpl;
    imageUploadAuth?: ImageUploadAuthExecutor;
  }) {
    this.config = input.config;
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.imageUploadAuth =
      input.imageUploadAuth ?? new ImageUploadAuthService({ config: input.config });
  }

  async login(): Promise<string> {
    const response = await this.fetchJson(`${this.config.api_base_url}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: this.config.account,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      throw new ZentaoHttpError({
        status: response.status,
        path: "/tokens",
        responseBody: response.body,
      });
    }

    if (!isTokenResponse(response.body)) {
      throw new Error("ZenTao login response did not include token");
    }

    this.token = response.body.token;
    return this.token;
  }

  async request(request: ZentaoRequest): Promise<unknown> {
    return this.requestWithRetry(request, false);
  }

  imageUploadAuthInfo(): ImageUploadAuthInfo {
    return this.imageUploadAuth.info();
  }

  async authenticateImageUpload(): Promise<ImageUploadAuthResult> {
    return this.imageUploadAuth.authenticate();
  }

  async uploadPasteImage(request: ZentaoPasteImageRequest): Promise<string> {
    return this.imageUploadAuth.execute(async (auth) => {
      const response = await this.postPasteImage(request, auth);
      if (isPasteAuthFailure(response.status, response.body)) {
        throw new ImageUploadAuthRejectedError();
      }
      if (!response.ok) {
        throw new Error(
          `PASTE_IMAGE_FAILED: ZenTao paste image request failed with status ${response.status}`,
        );
      }
      return {
        value: response.body,
        responseHeaders: response.headers,
      };
    });
  }

  private async requestWithRetry(
    request: ZentaoRequest,
    alreadyRetried: boolean,
  ): Promise<unknown> {
    const token = this.token ?? (await this.login());
    const response = await this.fetchJson(this.buildUrl(request), {
      method: request.method,
      headers: {
        "content-type": "application/json",
        Token: token,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    if (response.ok) {
      return response.body;
    }

    if (!alreadyRetried && isAuthFailure(response.status, response.body)) {
      this.token = undefined;
      return this.requestWithRetry(request, true);
    }

    throw new ZentaoHttpError({
      status: response.status,
      path: request.path,
      responseBody: response.body,
    });
  }

  private async postPasteImage(
    request: ZentaoPasteImageRequest,
    auth: ImageUploadAuthContext,
  ): Promise<TextResponse> {
    const formData = new FormData();
    formData.set("editor", request.editorHtml);

    return this.fetchSiteText(this.buildSiteUrl(request.endpoint), {
      method: "POST",
      headers: {
        Cookie: auth.cookie,
        "User-Agent": auth.requestContext.userAgent,
        Referer: auth.requestContext.referer,
        Origin: auth.requestContext.origin,
        "X-Requested-With": auth.requestContext.xRequestedWith,
      },
      body: formData,
      redirect: "manual",
    });
  }

  private buildUrl(request: ZentaoRequest): string {
    const url = new URL(`${this.config.api_base_url}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildSiteUrl(path: string): string {
    return new URL(path, `${this.config.base_url}/`).toString();
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(this.config.timeout_seconds * 1000),
    });

    const text = await response.text();
    const body = text.length === 0 ? null : parseJsonOrText(text);
    return { ok: response.ok, status: response.status, body };
  }

  private async fetchSiteText(url: string, init: RequestInit): Promise<TextResponse> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(this.config.timeout_seconds * 1000),
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
      headers: response.headers,
    };
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isTokenResponse(value: unknown): value is { token: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "token" in value &&
      typeof (value as { token: unknown }).token === "string",
  );
}

function isAuthFailure(status: number, body: unknown): boolean {
  if (status === 401 || status === 403) return true;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return /unauthorized|unauthenticated|invalid token|token expired/i.test(text);
}

function isPasteAuthFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status >= 300 && status < 400) return true;
  return /user-deny|unauthorized|unauthenticated|invalid token|token expired|<form[^>]+login|name=["']?account|name=["']?password/i.test(
    body,
  );
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|token/i.test(key) ? "<redacted>" : redactSecrets(item),
      ]),
    );
  }
  return value;
}
