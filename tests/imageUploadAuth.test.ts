import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultImageUploadAuthPath,
  ImageUploadAuthRejectedError,
  ImageUploadAuthService,
  type ImageUploadBrowserSession,
} from "../src/zentao/imageUploadAuth.js";

function testConfig(
  account = "demo",
  baseUrl = "https://zentao.example.com",
) {
  return {
    base_url: baseUrl,
    api_base_url: `${baseUrl}/api.php/v1`,
    account,
    password: "secret",
    timeout_seconds: 20,
  };
}

function browserSession(
  cookie: string,
  overrides: Partial<ImageUploadBrowserSession> = {},
): ImageUploadBrowserSession {
  return {
    cookie,
    userAgent: "TestBrowser/1.0",
    referer: "https://zentao.example.com/my.html",
    ...overrides,
  };
}

function authPath(name: string): string {
  return join(
    ".tmp",
    "tests",
    `${name}-${process.pid}-${randomBytes(6).toString("hex")}.json`,
  );
}

function migrationPaths(name: string) {
  const directory = join(
    ".tmp",
    "tests",
    `${name}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  return {
    legacyPath: join(directory, "zentao", "auth.json"),
    storagePath: join(directory, ".zentao", "auth.json"),
  };
}

async function readStored(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    base_url: string;
    account: string;
    cookie: string;
    request_context: {
      user_agent: string;
      referer: string;
      origin: string;
      x_requested_with: string;
    };
    captured_at: string;
    invalidated_at: string | null;
  };
}

function storedV2(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    base_url: "https://zentao.example.com",
    account: "demo",
    cookie: "zentaosid=stored",
    request_context: {
      user_agent: "StoredBrowser/1.0",
      referer: "https://zentao.example.com/my.html",
      origin: "https://zentao.example.com",
      x_requested_with: "XMLHttpRequest",
    },
    captured_at: new Date().toISOString(),
    invalidated_at: null,
    ...overrides,
  };
}

describe("ImageUploadAuthService", () => {
  it("uses ~/.zentao/auth.json as the default storage path", () => {
    expect(defaultImageUploadAuthPath()).toBe(
      join(homedir(), ".zentao", "auth.json"),
    );
  });

  it("moves legacy version 2 authentication and reuses it without opening a browser", async () => {
    const { legacyPath, storagePath } = migrationPaths("migrate-v2");
    const legacyAuth = storedV2();
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify(legacyAuth), "utf8");

    let browserCalls = 0;
    let usedCookie = "";
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath,
      legacyStoragePath: legacyPath,
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession("zentaosid=unexpected");
      },
    });

    await service.execute(async (auth) => {
      usedCookie = auth.cookie;
      return { value: undefined };
    });

    expect(browserCalls).toBe(0);
    expect(usedCookie).toBe("zentaosid=stored");
    expect(await readStored(storagePath)).toEqual(legacyAuth);
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refreshes and upgrades a migrated version 1 file", async () => {
    const { legacyPath, storagePath } = migrationPaths("migrate-v1");
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        base_url: "https://zentao.example.com",
        account: "demo",
        cookie: "zentaosid=legacy",
        captured_at: new Date().toISOString(),
        invalidated_at: null,
      }),
      "utf8",
    );

    let browserCalls = 0;
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath,
      legacyStoragePath: legacyPath,
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession("zentaosid=fresh");
      },
    });

    await service.execute(async () => ({ value: undefined }));

    expect(browserCalls).toBe(1);
    expect(await readStored(storagePath)).toMatchObject({
      version: 2,
      cookie: "zentaosid=fresh",
    });
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prefers the new authentication file when both paths exist", async () => {
    const { legacyPath, storagePath } = migrationPaths("migration-conflict");
    await mkdir(dirname(legacyPath), { recursive: true });
    await mkdir(dirname(storagePath), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify(storedV2({ cookie: "zentaosid=legacy" })),
      "utf8",
    );
    await writeFile(
      storagePath,
      JSON.stringify(storedV2({ cookie: "zentaosid=new" })),
      "utf8",
    );

    let browserCalls = 0;
    let usedCookie = "";
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath,
      legacyStoragePath: legacyPath,
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession("zentaosid=unexpected");
      },
    });

    await service.execute(async (auth) => {
      usedCookie = auth.cookie;
      return { value: undefined };
    });

    expect(browserCalls).toBe(0);
    expect(usedCookie).toBe("zentaosid=new");
    expect((await readStored(storagePath)).cookie).toBe("zentaosid=new");
    expect((await readStored(legacyPath)).cookie).toBe("zentaosid=legacy");
  });

  it("persists version 2 browser context and returns only field names", async () => {
    const path = authPath("authenticate-v2");
    let browserCalls = 0;
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async (config) => {
        browserCalls += 1;
        expect(config.account).toBe("demo");
        return browserSession("zentaosid=s1; lang=zh-cn");
      },
    });

    const result = await service.authenticate();
    const stored = await readStored(path);

    expect(browserCalls).toBe(1);
    expect(result).toMatchObject({
      authenticated: true,
      source: "browser",
      base_url: "https://zentao.example.com",
      storage_path: path,
      cookie_names: ["zentaosid", "lang"],
      request_context_fields: [
        "user_agent",
        "referer",
        "origin",
        "x_requested_with",
      ],
      persisted: true,
    });
    expect(JSON.stringify(result)).not.toContain("zentaosid=s1");
    expect(JSON.stringify(result)).not.toContain("TestBrowser/1.0");
    expect(JSON.stringify(result)).not.toContain("https://zentao.example.com/my.html");
    expect(JSON.stringify(result)).not.toContain("XMLHttpRequest");
    expect(stored).toMatchObject({
      version: 2,
      base_url: "https://zentao.example.com",
      account: "demo",
      cookie: "zentaosid=s1; lang=zh-cn",
      request_context: {
        user_agent: "TestBrowser/1.0",
        referer: "https://zentao.example.com/my.html",
        origin: "https://zentao.example.com",
        x_requested_with: "XMLHttpRequest",
      },
      invalidated_at: null,
    });

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("reuses persisted version 2 authentication in a new service instance", async () => {
    const path = authPath("cross-session");
    const first = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () =>
        browserSession("zentaosid=persisted"),
    });
    await first.authenticate();

    let browserCalls = 0;
    const second = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession("zentaosid=unexpected");
      },
    });
    let usedAuth:
      | {
          cookie: string;
          userAgent: string;
          referer: string;
          origin: string;
          xRequestedWith: string;
        }
      | undefined;

    await expect(
      second.execute(async (auth) => {
        usedAuth = {
          cookie: auth.cookie,
          ...auth.requestContext,
        };
        return { value: "ok" };
      }),
    ).resolves.toBe("ok");

    expect(browserCalls).toBe(0);
    expect(usedAuth).toEqual({
      cookie: "zentaosid=persisted",
      userAgent: "TestBrowser/1.0",
      referer: "https://zentao.example.com/my.html",
      origin: "https://zentao.example.com",
      xRequestedWith: "XMLHttpRequest",
    });
  });

  it("refreshes a version 1 file instead of guessing request context", async () => {
    const path = authPath("version-1");
    await mkdir(join(".tmp", "tests"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        base_url: "https://zentao.example.com",
        account: "demo",
        cookie: "zentaosid=legacy",
        captured_at: new Date().toISOString(),
        invalidated_at: null,
      }),
      "utf8",
    );

    let usedCookie = "";
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () =>
        browserSession("zentaosid=fresh"),
    });

    await service.execute(async (auth) => {
      usedCookie = auth.cookie;
      return { value: undefined };
    });

    expect(usedCookie).toBe("zentaosid=fresh");
    expect(await readStored(path)).toMatchObject({
      version: 2,
      cookie: "zentaosid=fresh",
    });
  });

  it.each([
    {
      name: "another account",
      stored: storedV2({ account: "other" }),
    },
    {
      name: "another base URL",
      stored: storedV2({
        base_url: "https://other.example.com",
        request_context: {
          user_agent: "StoredBrowser/1.0",
          referer: "https://other.example.com/my.html",
          origin: "https://other.example.com",
          x_requested_with: "XMLHttpRequest",
        },
      }),
    },
  ])("does not reuse authentication stored for $name", async ({ stored }) => {
    const path = authPath("identity");
    await mkdir(join(".tmp", "tests"), { recursive: true });
    await writeFile(path, JSON.stringify(stored), "utf8");

    let usedCookie = "";
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () =>
        browserSession("zentaosid=fresh"),
    });

    await service.execute(async (auth) => {
      usedCookie = auth.cookie;
      return { value: undefined };
    });

    expect(usedCookie).toBe("zentaosid=fresh");
    expect(await readStored(path)).toMatchObject({
      version: 2,
      base_url: "https://zentao.example.com",
      account: "demo",
    });
  });

  it("refreshes invalid JSON instead of sending its contents", async () => {
    const path = authPath("invalid-json");
    await mkdir(join(".tmp", "tests"), { recursive: true });
    await writeFile(path, "{not-json", "utf8");

    let usedCookie = "";
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () =>
        browserSession("zentaosid=fresh"),
    });

    await service.execute(async (auth) => {
      usedCookie = auth.cookie;
      return { value: undefined };
    });

    expect(usedCookie).toBe("zentaosid=fresh");
  });

  it("invalidates stale authentication, refreshes, and retries exactly once", async () => {
    const path = authPath("retry");
    let browserCalls = 0;
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession(
          browserCalls === 1
            ? "zentaosid=stale"
            : "zentaosid=fresh",
        );
      },
    });
    await service.authenticate();

    const attemptedCookies: string[] = [];
    const result = await service.execute(async (auth) => {
      attemptedCookies.push(auth.cookie);
      if (attemptedCookies.length === 1) {
        throw new ImageUploadAuthRejectedError();
      }
      return { value: "uploaded" };
    });

    expect(result).toBe("uploaded");
    expect(browserCalls).toBe(2);
    expect(attemptedCookies).toEqual([
      "zentaosid=stale",
      "zentaosid=fresh",
    ]);
    expect(await readStored(path)).toMatchObject({
      version: 2,
      cookie: "zentaosid=fresh",
      invalidated_at: null,
    });
  });

  it("marks the refreshed session invalid when the retry is rejected", async () => {
    const path = authPath("retry-fails");
    let browserCalls = 0;
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () => {
        browserCalls += 1;
        return browserSession(`zentaosid=s${browserCalls}`);
      },
    });
    await service.authenticate();

    let attempts = 0;
    await expect(
      service.execute(async () => {
        attempts += 1;
        throw new ImageUploadAuthRejectedError();
      }),
    ).rejects.toThrow(/ZENTAO_AUTH_FAILED/);

    expect(attempts).toBe(2);
    expect(browserCalls).toBe(2);
    expect((await readStored(path)).invalidated_at).not.toBeNull();
  });

  it("updates only cookies and timestamp when the server rotates cookies", async () => {
    const path = authPath("set-cookie");
    const service = new ImageUploadAuthService({
      config: testConfig(),
      storagePath: path,
      browserSessionProvider: async () =>
        browserSession("zentaosid=s1"),
    });
    await service.authenticate();
    const before = await readStored(path);

    await service.execute(async () => ({
      value: undefined,
      responseHeaders: new Headers({
        "set-cookie": "theme=dark; Path=/",
      }),
    }));

    const after = await readStored(path);
    expect(after.cookie).toBe("zentaosid=s1; theme=dark");
    expect(after.request_context).toEqual(before.request_context);
    expect(after.version).toBe(2);
    expect(after.invalidated_at).toBeNull();
  });
});
