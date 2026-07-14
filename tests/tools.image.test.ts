import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  imageToolsForTest,
  resolveUploadPasteImageRequest,
} from "../src/tools/imageTools.js";
import type { ZentaoPasteImageRequest } from "../src/zentao/client.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function uploadClient(responseHtml = '<img src="/file-read-14215.png" alt="server" />') {
  const uploads: ZentaoPasteImageRequest[] = [];
  return {
    uploads,
    request: async () => ({}),
    uploadPasteImage: async (request: ZentaoPasteImageRequest) => {
      uploads.push(request);
      return responseHtml;
    },
  };
}

describe("paste image tools", () => {
  it("dry-runs local PNG upload without leaking base64", async () => {
    const imagePath = join(".tmp", "tests", "one-pixel.png");
    mkdirSync(join(".tmp", "tests"), { recursive: true });
    writeFileSync(imagePath, tinyPng);
    const client = uploadClient();

    const result = await resolveUploadPasteImageRequest(
      {
        image_path: imagePath,
        alt: '缺陷截图 "A"',
      },
      client,
      () => "/file-ajaxPasteImg-abcdef123456.html",
    );

    expect(client.uploads).toHaveLength(0);
    expect(result).toMatchObject({
      method: "POST",
      path: "/file-ajaxPasteImg-abcdef123456.html",
      requires_confirmation: true,
      request_body: {
        file_name: "one-pixel.png",
        mime_type: "image/png",
        size: tinyPng.length,
        authentication: "zentao_auth",
      },
    });
    expect(JSON.stringify(result)).toContain("base64,<redacted>");
    expect(JSON.stringify(result)).not.toContain(tinyPng.toString("base64"));
    expect(JSON.stringify(result)).toContain("&quot;A&quot;");
  });

  it("uploads base64 image and returns a safe img tag when confirmed", async () => {
    const client = uploadClient();

    const result = await resolveUploadPasteImageRequest(
      {
        image_base64: tinyPng.toString("base64"),
        mime_type: "image/png",
        alt: "订单时间异常截图 <x>",
        paste_endpoint: "/file-ajaxPasteImg-6a4f423d1ef07.html",
        confirm: true,
      },
      client,
      () => "/file-ajaxPasteImg-abcdef123456.html",
    );

    expect(client.uploads).toHaveLength(1);
    expect(client.uploads[0]).toMatchObject({
      endpoint: "/file-ajaxPasteImg-6a4f423d1ef07.html",
    });
    expect(Object.keys(client.uploads[0]).sort()).toEqual([
      "editorHtml",
      "endpoint",
    ]);
    expect(client.uploads[0].editorHtml).toContain("data:image/png;base64,");
    expect(client.uploads[0].editorHtml).toContain(
      'alt="订单时间异常截图 &lt;x&gt;"',
    );
    expect(result).toEqual({
      src: "/file-read-14215.png",
      html: '<img src="/file-read-14215.png" alt="订单时间异常截图 &lt;x&gt;" />',
      file_name: "paste-image.png",
      size: tinyPng.length,
    });
  });

  it("parses paste image response and rejects non file-read images", () => {
    expect(
      imageToolsForTest.parsePasteImageResponse(
        '<img src="/file-read-14215.png" alt="server" />',
        "缺陷截图",
      ),
    ).toEqual({
      src: "/file-read-14215.png",
      html: '<img src="/file-read-14215.png" alt="缺陷截图" />',
    });

    expect(() =>
      imageToolsForTest.parsePasteImageResponse(
        '<img src="https://example.com/a.png" />',
        "x",
      ),
    ).toThrow(/PASTE_IMAGE_FAILED/);
  });

  it("rejects invalid base64", async () => {
    await expect(
      resolveUploadPasteImageRequest(
        {
          image_base64: "not base64!",
          mime_type: "image/png",
          confirm: true,
        },
        uploadClient(),
      ),
    ).rejects.toThrow(/IMAGE_INVALID_BASE64/);
  });

  it("requires exactly one image input", async () => {
    await expect(
      resolveUploadPasteImageRequest({}, uploadClient()),
    ).rejects.toThrow(/Expected exactly one/);
  });

  it("rejects legacy authentication arguments", async () => {
    await expect(
      resolveUploadPasteImageRequest(
        {
          image_base64: tinyPng.toString("base64"),
          mime_type: "image/png",
          web_cookie: "zentaosid=s1",
          confirm: true,
        },
        uploadClient(),
      ),
    ).rejects.toThrow(/Unrecognized key/);
  });

  it("rejects invalid paste endpoints", async () => {
    await expect(
      resolveUploadPasteImageRequest(
        {
          image_base64: tinyPng.toString("base64"),
          mime_type: "image/png",
          paste_endpoint: "/api.php/v1/products",
          confirm: true,
        },
        uploadClient(),
      ),
    ).rejects.toThrow(/PASTE_ENDPOINT_INVALID/);
  });
});
