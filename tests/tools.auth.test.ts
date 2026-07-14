import { describe, expect, it } from "vitest";
import { resolveAuthRequest } from "../src/tools/authTools.js";

function authClient() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    request: async () => ({}),
    imageUploadAuthInfo: () => ({
      base_url: "https://zentao.example.com",
      storage_path: "C:\\Users\\demo\\.zentao\\auth.json",
    }),
    authenticateImageUpload: async () => {
      calls += 1;
      return {
        authenticated: true as const,
        source: "browser" as const,
        base_url: "https://zentao.example.com",
        storage_path: "C:\\Users\\demo\\.zentao\\auth.json",
        captured_at: "2026-07-13T10:00:00.000Z",
        cookie_names: ["zentaosid", "lang"],
        request_context_fields: [
          "user_agent" as const,
          "referer" as const,
          "origin" as const,
          "x_requested_with" as const,
        ],
        persisted: true as const,
      };
    },
  };
}

describe("zentao_auth tool", () => {
  it("returns a dry-run summary without authenticating", async () => {
    const client = authClient();

    const result = await resolveAuthRequest({}, client);

    expect(client.calls).toBe(0);
    expect(result).toEqual({
      action: "refresh_image_upload_auth",
      storage_path: "C:\\Users\\demo\\.zentao\\auth.json",
      base_url: "https://zentao.example.com",
      requires_confirmation: true,
    });
  });

  it("forces browser authentication and returns only context field names", async () => {
    const client = authClient();

    const result = await resolveAuthRequest({ confirm: true }, client);

    expect(client.calls).toBe(1);
    expect(result).toMatchObject({
      authenticated: true,
      source: "browser",
      cookie_names: ["zentaosid", "lang"],
      request_context_fields: [
        "user_agent",
        "referer",
        "origin",
        "x_requested_with",
      ],
      persisted: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("zentaosid=");
    expect(serialized).not.toContain("Mozilla/");
    expect(serialized).not.toContain("XMLHttpRequest");
  });

  it("rejects unknown arguments", async () => {
    await expect(
      resolveAuthRequest({ confirm: true, cookie: "secret" }, authClient()),
    ).rejects.toThrow(/Unrecognized key/);
  });
});
