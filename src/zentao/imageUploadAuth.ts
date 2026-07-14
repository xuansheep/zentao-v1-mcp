import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ZentaoConfig } from "../config.js";

export type ImageUploadRequestContext = {
  userAgent: string;
  referer: string;
  origin: string;
  xRequestedWith: string;
};

export type ImageUploadAuthContext = {
  cookie: string;
  capturedAt: string;
  requestContext: ImageUploadRequestContext;
};

export type ImageUploadAuthInfo = {
  base_url: string;
  storage_path: string;
};

export type ImageUploadAuthResult = ImageUploadAuthInfo & {
  authenticated: true;
  source: "browser";
  captured_at: string;
  cookie_names: string[];
  request_context_fields: Array<
    "user_agent" | "referer" | "origin" | "x_requested_with"
  >;
  persisted: true;
};

export type AuthenticatedOperationResult<T> = {
  value: T;
  responseHeaders?: Headers;
};

export type ImageUploadAuthExecutor = {
  info(): ImageUploadAuthInfo;
  authenticate(): Promise<ImageUploadAuthResult>;
  execute<T>(
    operation: (context: ImageUploadAuthContext) => Promise<AuthenticatedOperationResult<T>>,
  ): Promise<T>;
};

export type ImageUploadBrowserSession = {
  cookie: string;
  userAgent: string;
  referer: string;
};

export type ImageUploadBrowserSessionProvider = (
  config: ZentaoConfig,
) => Promise<ImageUploadBrowserSession>;

const StoredRequestContextSchema = z
  .object({
    user_agent: z.string().min(1),
    referer: z.string().url(),
    origin: z.string().url(),
    x_requested_with: z.string().min(1),
  })
  .strict();

const StoredImageUploadAuthSchema = z
  .object({
    version: z.literal(2),
    base_url: z.string().url(),
    account: z.string().min(1),
    cookie: z.string().min(1),
    request_context: StoredRequestContextSchema,
    captured_at: z.string().datetime(),
    invalidated_at: z.string().datetime().nullable(),
  })
  .strict();

type StoredImageUploadAuth = z.infer<typeof StoredImageUploadAuthSchema>;

const requestContextFieldNames = [
  "user_agent",
  "referer",
  "origin",
  "x_requested_with",
] as const;

export class ImageUploadAuthRejectedError extends Error {
  constructor() {
    super("ZENTAO_AUTH_FAILED: ZenTao paste image endpoint rejected authentication");
  }
}

export class ImageUploadAuthService implements ImageUploadAuthExecutor {
  private readonly config: ZentaoConfig;
  private readonly storagePath: string;
  private readonly legacyStoragePath?: string;
  private readonly browserSessionProvider: ImageUploadBrowserSessionProvider;
  private migrationPromise?: Promise<void>;

  constructor(input: {
    config: ZentaoConfig;
    storagePath?: string;
    legacyStoragePath?: string;
    browserSessionProvider?: ImageUploadBrowserSessionProvider;
  }) {
    this.config = input.config;
    this.storagePath = input.storagePath ?? defaultImageUploadAuthPath();
    this.legacyStoragePath =
      input.legacyStoragePath ??
      (input.storagePath === undefined
        ? legacyImageUploadAuthPath()
        : undefined);
    this.browserSessionProvider =
      input.browserSessionProvider ?? acquireBrowserImageUploadSession;
  }

  info(): ImageUploadAuthInfo {
    return {
      base_url: this.config.base_url,
      storage_path: this.storagePath,
    };
  }

  async authenticate(): Promise<ImageUploadAuthResult> {
    await this.migrateLegacyAuthIfNeeded();
    const auth = await this.refresh();
    return {
      authenticated: true,
      source: "browser",
      ...this.info(),
      captured_at: auth.capturedAt,
      cookie_names: CookieJar.fromCookieHeader(auth.cookie).names(),
      request_context_fields: [...requestContextFieldNames],
      persisted: true,
    };
  }

  async execute<T>(
    operation: (context: ImageUploadAuthContext) => Promise<AuthenticatedOperationResult<T>>,
  ): Promise<T> {
    await this.migrateLegacyAuthIfNeeded();
    let auth = await this.ensureAuth();

    try {
      return await this.completeOperation(auth, await operation(auth));
    } catch (error) {
      if (!(error instanceof ImageUploadAuthRejectedError)) throw error;
    }

    await this.invalidate(auth);
    auth = await this.refresh();

    try {
      return await this.completeOperation(auth, await operation(auth));
    } catch (error) {
      if (error instanceof ImageUploadAuthRejectedError) {
        await this.invalidate(auth);
      }
      throw error;
    }
  }

  private async migrateLegacyAuthIfNeeded(): Promise<void> {
    const legacyStoragePath = this.legacyStoragePath;
    if (legacyStoragePath === undefined) return;

    this.migrationPromise ??= (async () => {
      try {
        if (await pathExists(this.storagePath)) return;
        if (!(await pathExists(legacyStoragePath))) return;

        const directory = dirname(this.storagePath);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") {
          await chmod(directory, 0o700);
        }

        try {
          await rename(legacyStoragePath, this.storagePath);
        } catch (error) {
          if (await pathExists(this.storagePath)) return;
          throw error;
        }

        if (process.platform !== "win32") {
          await chmod(this.storagePath, 0o600);
        }
      } catch {
        throw new Error(
          "IMAGE_UPLOAD_AUTH_MIGRATION_FAILED: unable to move legacy auth.json",
        );
      }
    })();

    await this.migrationPromise;
  }

  private async ensureAuth(): Promise<ImageUploadAuthContext> {
    const stored = await this.load();
    if (stored === undefined || stored.invalidated_at !== null) {
      return this.refresh();
    }
    return toAuthContext(stored);
  }

  private async refresh(): Promise<ImageUploadAuthContext> {
    let session: ImageUploadBrowserSession;
    try {
      session = await this.browserSessionProvider(this.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("BROWSER_SESSION_")) throw error;
      throw new Error(`BROWSER_SESSION_FAILED: ${message}`);
    }

    const cookies = CookieJar.fromCookieHeader(session.cookie);
    if (cookies.isEmpty()) {
      throw new Error("BROWSER_SESSION_FAILED: browser login did not produce ZenTao cookies");
    }

    const requestContext: ImageUploadRequestContext = {
      userAgent: requireBrowserValue(session.userAgent, "user agent"),
      referer: requireBrowserUrl(session.referer, "referer"),
      origin: new URL(this.config.base_url).origin,
      xRequestedWith: "XMLHttpRequest",
    };
    const capturedAt = new Date().toISOString();
    const stored = this.createStoredAuth(
      cookies.toHeader(),
      requestContext,
      capturedAt,
      null,
    );
    await this.save(stored);
    return toAuthContext(stored);
  }

  private async completeOperation<T>(
    auth: ImageUploadAuthContext,
    result: AuthenticatedOperationResult<T>,
  ): Promise<T> {
    const setCookieHeaders =
      result.responseHeaders === undefined
        ? []
        : readSetCookieHeaders(result.responseHeaders);
    if (setCookieHeaders.length > 0) {
      const cookies = CookieJar.fromCookieHeader(auth.cookie);
      for (const header of setCookieHeaders) cookies.setFromHeader(header);
      if (!cookies.isEmpty()) {
        await this.save(
          this.createStoredAuth(
            cookies.toHeader(),
            auth.requestContext,
            new Date().toISOString(),
            null,
          ),
        );
      }
    }
    return result.value;
  }

  private async invalidate(auth: ImageUploadAuthContext): Promise<void> {
    await this.save(
      this.createStoredAuth(
        auth.cookie,
        auth.requestContext,
        auth.capturedAt,
        new Date().toISOString(),
      ),
    );
  }

  private async load(): Promise<StoredImageUploadAuth | undefined> {
    let text: string;
    try {
      text = await readFile(this.storagePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error("IMAGE_UPLOAD_AUTH_STORE_READ_FAILED: unable to read auth.json");
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }

    const parsed = StoredImageUploadAuthSchema.safeParse(value);
    if (!parsed.success) return undefined;
    if (
      normalizeBaseUrl(parsed.data.base_url) !== this.config.base_url ||
      parsed.data.account !== this.config.account
    ) {
      return undefined;
    }
    return parsed.data;
  }

  private createStoredAuth(
    cookie: string,
    requestContext: ImageUploadRequestContext,
    capturedAt: string,
    invalidatedAt: string | null,
  ): StoredImageUploadAuth {
    return {
      version: 2,
      base_url: this.config.base_url,
      account: this.config.account,
      cookie,
      request_context: {
        user_agent: requestContext.userAgent,
        referer: requestContext.referer,
        origin: requestContext.origin,
        x_requested_with: requestContext.xRequestedWith,
      },
      captured_at: capturedAt,
      invalidated_at: invalidatedAt,
    };
  }

  private async save(value: StoredImageUploadAuth): Promise<void> {
    const directory = dirname(this.storagePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(directory, 0o700);
    }

    const temporaryPath = `${this.storagePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, this.storagePath);
    if (process.platform !== "win32") {
      await chmod(this.storagePath, 0o600);
    }
  }
}

export function defaultImageUploadAuthPath(): string {
  return join(homedir(), ".zentao", "auth.json");
}

function legacyImageUploadAuthPath(): string {
  return join(homedir(), "zentao", "auth.json");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function acquireBrowserImageUploadSession(
  config: ZentaoConfig,
): Promise<ImageUploadBrowserSession> {
  const playwright = await importOptionalPlaywright();
  const timeout = Math.max(config.timeout_seconds * 1000, 120_000);
  const browser = await playwright.chromium.launch({ headless: false });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const loginUrl = new URL("/user-login.html", `${config.base_url}/`).toString();
    const homeUrl = new URL("/my.html", `${config.base_url}/`).toString();

    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout });
    await fillBrowserLoginForm(page, config, timeout);
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout }).catch(() => undefined);
    await waitForBrowserLogin(page, timeout);

    const cookie = cookiesToHeader(await context.cookies(config.base_url));
    if (cookie.length === 0) {
      throw new Error("BROWSER_SESSION_FAILED: browser login did not produce ZenTao cookies");
    }
    return {
      cookie,
      userAgent: await page.evaluate(() => navigator.userAgent),
      referer: page.url(),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function fillBrowserLoginForm(
  page: BrowserPageLike,
  config: ZentaoConfig,
  timeout: number,
): Promise<void> {
  const account = page.locator('input[name="account"], input#account');
  if ((await account.count().catch(() => 0)) === 0) return;

  await account.fill(config.account, { timeout: Math.min(timeout, 5_000) });
  const password = page.locator('input[name="password"], input[type="password"]');
  await password.fill(config.password, { timeout: Math.min(timeout, 5_000) });

  const submit = page.locator('button[type="submit"], input[type="submit"], #submit');
  if ((await submit.count().catch(() => 0)) > 0) {
    await submit.click({ timeout: Math.min(timeout, 5_000) });
    return;
  }
  await password.press("Enter", { timeout: Math.min(timeout, 5_000) });
}

async function waitForBrowserLogin(
  page: BrowserPageLike,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    () =>
      !window.location.href.includes("user-login") &&
      document.querySelector('input[name="account"], input[name="password"]') === null,
    undefined,
    { timeout },
  );
}

async function importOptionalPlaywright(): Promise<PlaywrightLike> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const module = await dynamicImport("playwright");
  if (!module || typeof module !== "object" || !("chromium" in module)) {
    throw new Error("BROWSER_SESSION_UNAVAILABLE: playwright chromium is unavailable");
  }
  return module as PlaywrightLike;
}

function requireBrowserValue(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`BROWSER_SESSION_FAILED: browser ${name} is empty`);
  }
  return trimmed;
}

function requireBrowserUrl(value: string, name: string): string {
  const trimmed = requireBrowserValue(value, name);
  try {
    return new URL(trimmed).toString();
  } catch {
    throw new Error(`BROWSER_SESSION_FAILED: browser ${name} is not a valid URL`);
  }
}

function toAuthContext(stored: StoredImageUploadAuth): ImageUploadAuthContext {
  return {
    cookie: stored.cookie,
    capturedAt: stored.captured_at,
    requestContext: {
      userAgent: stored.request_context.user_agent,
      referer: stored.request_context.referer,
      origin: stored.request_context.origin,
      xRequestedWith: stored.request_context.x_requested_with,
    },
  };
}

function cookiesToHeader(cookies: BrowserCookieLike[]): string {
  return cookies
    .filter((cookie) => cookie.name.length > 0 && cookie.value.length > 0)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  static fromCookieHeader(header: string): CookieJar {
    const jar = new CookieJar();
    for (const cookie of header.split(";")) {
      const separatorIndex = cookie.indexOf("=");
      if (separatorIndex <= 0) continue;
      const name = cookie.slice(0, separatorIndex).trim();
      const value = cookie.slice(separatorIndex + 1).trim();
      if (name.length > 0 && value.length > 0) {
        jar.cookies.set(name, value);
      }
    }
    return jar;
  }

  isEmpty(): boolean {
    return this.cookies.size === 0;
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  setFromHeader(header: string): void {
    const [pair, ...attributes] = header.split(";");
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) return;

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (name.length === 0) return;

    const removesCookie =
      value.length === 0 ||
      attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute)) ||
      attributes.some((attribute) => {
        const match = /^\s*expires\s*=\s*(.+)$/i.exec(attribute);
        return (
          match !== null &&
          Number.isFinite(Date.parse(match[1])) &&
          Date.parse(match[1]) <= Date.now()
        );
      });

    if (removesCookie) {
      this.cookies.delete(name);
      return;
    }
    this.cookies.set(name, value);
  }

  toHeader(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function readSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const direct = withGetter.getSetCookie?.();
  if (direct !== undefined && direct.length > 0) return direct;

  const combined = headers.get("set-cookie");
  return combined === null ? [] : splitCombinedSetCookie(combined);
}

function splitCombinedSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map((item) => item.trim());
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

type PlaywrightLike = {
  chromium: {
    launch(options: { headless: boolean }): Promise<BrowserLike>;
  };
};

type BrowserLike = {
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
};

type BrowserContextLike = {
  newPage(): Promise<BrowserPageLike>;
  cookies(urls?: string | string[]): Promise<BrowserCookieLike[]>;
};

type BrowserPageLike = {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  locator(selector: string): BrowserLocatorLike;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  url(): string;
  waitForFunction(
    pageFunction: () => boolean,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
};

type BrowserLocatorLike = {
  count(): Promise<number>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  click(options: { timeout: number }): Promise<void>;
  press(key: string, options: { timeout: number }): Promise<void>;
};

type BrowserCookieLike = {
  name: string;
  value: string;
};
