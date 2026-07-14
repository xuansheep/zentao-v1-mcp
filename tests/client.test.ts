import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZentaoClient } from "../src/zentao/client.js";
import {
  ImageUploadAuthService,
  type ImageUploadAuthExecutor,
} from "../src/zentao/imageUploadAuth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html", ...headers },
  });
}

function testConfig() {
  return {
    base_url: "https://zentao.example.com",
    api_base_url: "https://zentao.example.com/api.php/v1",
    account: "demo",
    password: "secret",
    timeout_seconds: 20,
  };
}

function authPath(name: string): string {
  return join(
    ".tmp",
    "tests",
    `client-${name}-${process.pid}-${randomBytes(6).toString("hex")}.json`,
  );
}

function browserSession(cookie: string) {
  return {
    cookie,
    userAgent: "TestBrowser/1.0",
    referer: "https://zentao.example.com/my.html",
  };
}

function directAuth(cookie = "zentaosid=s1"): ImageUploadAuthExecutor {
  return {
    info: () => ({
      base_url: "https://zentao.example.com",
      storage_path: "auth.json",
    }),
    authenticate: async () => ({
      authenticated: true,
      source: "browser",
      base_url: "https://zentao.example.com",
      storage_path: "auth.json",
      captured_at: "2026-07-13T10:00:00.000Z",
      cookie_names: ["zentaosid"],
      request_context_fields: [
        "user_agent",
        "referer",
        "origin",
        "x_requested_with",
      ],
      persisted: true,
    }),
    execute: async <T>(operation: Parameters<ImageUploadAuthExecutor["execute"]>[0]) => {
      const result = await operation({
        cookie,
        capturedAt: "2026-07-13T10:00:00.000Z",
        requestContext: {
          userAgent: "TestBrowser/1.0",
          referer: "https://zentao.example.com/my.html",
          origin: "https://zentao.example.com",
          xRequestedWith: "XMLHttpRequest",
        },
      });
      return result.value as T;
    },
  };
}

describe("ZentaoClient", () => {
  it("logs in and sends Token header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "abc" });
      return jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
      imageUploadAuth: directAuth(),
    });

    await client.request({ method: "GET", path: "/products" });

    expect(calls[0].url).toBe(
      "https://zentao.example.com/api.php/v1/tokens",
    );
    expect(calls[1].init?.headers).toMatchObject({ Token: "abc" });
  });

  it("re-logins once after an auth-style response", async () => {
    let productCalls = 0;
    let tokenCalls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith("/tokens")) {
        tokenCalls += 1;
        return jsonResponse({ token: `token-${tokenCalls}` });
      }
      productCalls += 1;
      return productCalls === 1
        ? jsonResponse({ error: "unauthorized" }, 401)
        : jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
      imageUploadAuth: directAuth(),
    });

    await expect(
      client.request({ method: "GET", path: "/products" }),
    ).resolves.toEqual({ ok: true });
    expect(tokenCalls).toBe(2);
    expect(productCalls).toBe(2);
  });

  it("adds query parameters to requests", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).endsWith("/tokens")) return jsonResponse({ token: "abc" });
      return jsonResponse({ ok: true });
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
      imageUploadAuth: directAuth(),
    });

    await client.request({
      method: "GET",
      path: "/products",
      query: { page: 1, limit: 20 },
    });

    expect(urls[1]).toBe(
      "https://zentao.example.com/api.php/v1/products?page=1&limit=20",
    );
  });

  it("uploads with the complete persisted browser request context", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return htmlResponse('<img src="/file-read-14215.png" alt="server" />');
    };

    const client = new ZentaoClient({
      config: testConfig(),
      fetchImpl,
      imageUploadAuth: directAuth("zentaosid=persisted; lang=zh-cn"),
    });

    const result = await client.uploadPasteImage({
      endpoint: "/file-ajaxPasteImg-abcdef123456.html",
      editorHtml: '<img src="data:image/png;base64,abc" alt="x" />',
    });

    expect(result).toContain("/file-read-14215.png");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://zentao.example.com/file-ajaxPasteImg-abcdef123456.html",
    );
    expect(calls[0].url).not.toContain("user-login");
    expect(calls[0].init?.headers).toMatchObject({
      Cookie: "zentaosid=persisted; lang=zh-cn",
      "User-Agent": "TestBrowser/1.0",
      Referer: "https://zentao.example.com/my.html",
      Origin: "https://zentao.example.com",
      "X-Requested-With": "XMLHttpRequest",
    });
    expect((calls[0].init?.body as FormData).get("editor")).toBe(
      '<img src="data:image/png;base64,abc" alt="x" />',
    );
  });

  it("lets the auth service refresh and retry once after upload auth failure", async () => {
    let browserCalls = 0;
    const auth = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: authPath("retry"),
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession(
          browserCalls === 1
            ? "zentaosid=stale"
            : "zentaosid=fresh",
        );
      },
    });
    await auth.authenticate();

    const headers: Array<Record<string, string>> = [];
    let pasteCalls = 0;
    const client = new ZentaoClient({
      config: testConfig(),
      imageUploadAuth: auth,
      fetchImpl: async (_url, init) => {
        headers.push(init?.headers as Record<string, string>);
        pasteCalls += 1;
        return pasteCalls === 1
          ? htmlResponse("user-deny")
          : htmlResponse('<img src="/file-read-14215.png" />');
      },
    });

    await expect(
      client.uploadPasteImage({
        endpoint: "/file-ajaxPasteImg-abcdef123456.html",
        editorHtml: '<img src="data:image/png;base64,abc" />',
      }),
    ).resolves.toContain("/file-read-14215.png");

    expect(browserCalls).toBe(2);
    expect(headers.map((item) => item.Cookie)).toEqual([
      "zentaosid=stale",
      "zentaosid=fresh",
    ]);
    for (const requestHeaders of headers) {
      expect(requestHeaders).toMatchObject({
        "User-Agent": "TestBrowser/1.0",
        Referer: "https://zentao.example.com/my.html",
        Origin: "https://zentao.example.com",
        "X-Requested-With": "XMLHttpRequest",
      });
    }
  });

  it("does not refresh authentication for non-auth upload failures", async () => {
    let browserCalls = 0;
    const auth = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: authPath("server-error"),
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession("zentaosid=s1");
      },
    });
    await auth.authenticate();

    const client = new ZentaoClient({
      config: testConfig(),
      imageUploadAuth: auth,
      fetchImpl: async () => htmlResponse("server error", 500),
    });

    await expect(
      client.uploadPasteImage({
        endpoint: "/file-ajaxPasteImg-abcdef123456.html",
        editorHtml: '<img src="data:image/png;base64,abc" />',
      }),
    ).rejects.toThrow(/PASTE_IMAGE_FAILED/);
    expect(browserCalls).toBe(1);
  });

  it("delegates explicit authentication to the auth service", async () => {
    let calls = 0;
    const auth = directAuth();
    const client = new ZentaoClient({
      config: testConfig(),
      imageUploadAuth: {
        ...auth,
        authenticate: async () => {
          calls += 1;
          return auth.authenticate();
        },
      },
    });

    const result = await client.authenticateImageUpload();

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      authenticated: true,
      source: "browser",
      request_context_fields: [
        "user_agent",
        "referer",
        "origin",
        "x_requested_with",
      ],
      persisted: true,
    });
  });
});
