import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { ensureConfirmed } from "../safety.js";
import type { ZentaoPasteImageRequest } from "../zentao/client.js";
import type { McpServerLike, ZentaoRequester } from "./queryTools.js";

type PasteImageUploader = {
  uploadPasteImage(request: ZentaoPasteImageRequest): Promise<string>;
};

type UploadPasteImageClient = ZentaoRequester & Partial<PasteImageUploader>;

const supportedMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const mimeTypeSchema = z.enum(supportedMimeTypes);
const maxImageBytes = 5 * 1024 * 1024;

const uploadPasteImageInputSchema = z
  .object({
    image_path: z.string().min(1).optional().describe("Local image path."),
    image_base64: z.string().min(1).optional().describe("Base64 image content, optionally as a data URL."),
    mime_type: mimeTypeSchema.optional().describe("Required when base64 content has no detectable image header."),
    alt: z.string().default("image").describe("Image alt text inserted into the returned img tag."),
    paste_endpoint: z.string().min(1).optional().describe("ZenTao file-ajaxPasteImg endpoint path."),
    confirm: z.boolean().optional().describe("Must be true to upload the image to ZenTao."),
  })
  .strict();

type UploadPasteImageArgs = z.infer<typeof uploadPasteImageInputSchema>;

type PreparedImage = {
  dataUrl: string;
  fileName: string;
  mimeType: SupportedMimeType;
  size: number;
};

type SupportedMimeType = (typeof supportedMimeTypes)[number];

export type UploadPasteImageResult = {
  src: string;
  html: string;
  file_name: string;
  size: number;
};

export async function resolveUploadPasteImageRequest(
  args: unknown,
  client: UploadPasteImageClient,
  createEndpoint: () => string = createPasteImageEndpoint,
): Promise<UploadPasteImageResult | ImageUploadSummary> {
  const parsed = parseUploadPasteImageArgs(args);
  const image = prepareImage(parsed);
  const endpoint = parsePasteEndpoint(parsed.paste_endpoint ?? createEndpoint());
  const editorHtml = buildEditorHtml(image.dataUrl, parsed.alt);

  if (!ensureConfirmed(parsed.confirm)) {
    return createImageUploadSummary(endpoint, image, parsed.alt);
  }

  if (!hasPasteImageUploader(client)) {
    throw new Error("PASTE_IMAGE_FAILED: configured ZenTao client does not support paste image upload");
  }

  const rawHtml = await client.uploadPasteImage({
    endpoint,
    editorHtml,
  });
  const parsedResponse = parsePasteImageResponse(rawHtml, parsed.alt);
  return {
    ...parsedResponse,
    file_name: image.fileName,
    size: image.size,
  };
}

export function registerImageTools(server: McpServerLike, client: UploadPasteImageClient): void {
  server.tool(
    "zentao_upload_paste_image",
    "Upload a local or base64 image through ZenTao file-ajaxPasteImg using authentication managed by zentao_auth. Without confirm=true, returns a dry-run summary instead of uploading.",
    uploadPasteImageInputSchema.shape,
    async (args) => jsonText(await resolveUploadPasteImageRequest(args, client)),
  );
}

function parseUploadPasteImageArgs(args: unknown): UploadPasteImageArgs {
  const parsed = uploadPasteImageInputSchema.parse(args);
  const hasPath = parsed.image_path !== undefined;
  const hasBase64 = parsed.image_base64 !== undefined;
  if (hasPath === hasBase64) {
    throw new Error("Expected exactly one of: image_path, image_base64");
  }
  return parsed;
}

function prepareImage(parsed: UploadPasteImageArgs): PreparedImage {
  if (parsed.image_path !== undefined) {
    return prepareImagePath(parsed.image_path);
  }
  return prepareBase64Image(parsed.image_base64 as string, parsed.mime_type);
}

function prepareImagePath(imagePath: string): PreparedImage {
  if (!existsSync(imagePath)) {
    throw new Error(`IMAGE_NOT_FOUND: ${imagePath}`);
  }

  const stat = statSync(imagePath);
  if (!stat.isFile()) {
    throw new Error(`IMAGE_NOT_FOUND: ${imagePath}`);
  }
  if (stat.size > maxImageBytes) {
    throw new Error(`IMAGE_TOO_LARGE: image size ${stat.size} exceeds ${maxImageBytes} bytes`);
  }

  const buffer = readFileSync(imagePath);
  const mimeType = detectMimeType(buffer, imagePath);
  if (mimeType === undefined) {
    throw new Error("IMAGE_UNSUPPORTED_TYPE: supported image types are png, jpg, jpeg, webp and gif");
  }

  return {
    dataUrl: toDataUrl(buffer, mimeType),
    fileName: basename(imagePath),
    mimeType,
    size: buffer.length,
  };
}

function prepareBase64Image(imageBase64: string, inputMimeType: SupportedMimeType | undefined): PreparedImage {
  const decoded = decodeBase64Image(imageBase64);
  if (decoded.buffer.length > maxImageBytes) {
    throw new Error(`IMAGE_TOO_LARGE: image size ${decoded.buffer.length} exceeds ${maxImageBytes} bytes`);
  }

  const detectedMimeType = detectMimeType(decoded.buffer);
  const mimeType = inputMimeType ?? decoded.mimeType ?? detectedMimeType;
  if (!isSupportedMimeType(mimeType)) {
    throw new Error("IMAGE_UNSUPPORTED_TYPE: supported image types are png, jpg, jpeg, webp and gif");
  }

  return {
    dataUrl: toDataUrl(decoded.buffer, mimeType),
    fileName: `paste-image.${extensionForMimeType(mimeType)}`,
    mimeType,
    size: decoded.buffer.length,
  };
}

function decodeBase64Image(imageBase64: string): { buffer: Buffer; mimeType?: string } {
  const trimmed = imageBase64.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
  const base64Text = (dataUrlMatch ? dataUrlMatch[2] : trimmed).replace(/\s+/g, "");
  if (
    base64Text.length === 0 ||
    base64Text.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Text)
  ) {
    throw new Error("IMAGE_INVALID_BASE64: image_base64 is not valid base64");
  }

  const buffer = Buffer.from(base64Text, "base64");
  if (buffer.length === 0 || buffer.toString("base64").replace(/=+$/, "") !== base64Text.replace(/=+$/, "")) {
    throw new Error("IMAGE_INVALID_BASE64: image_base64 is not valid base64");
  }

  return { buffer, mimeType: dataUrlMatch?.[1] };
}

function detectMimeType(buffer: Buffer, fileName?: string): SupportedMimeType | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }

  const extension = fileName === undefined ? "" : extname(fileName).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return undefined;
}

function toDataUrl(buffer: Buffer, mimeType: SupportedMimeType): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildEditorHtml(dataUrl: string, alt: string): string {
  return `<img src="${dataUrl}" alt="${escapeHtml(alt)}" />`;
}

function parsePasteImageResponse(rawHtml: string, alt: string): Pick<UploadPasteImageResult, "src" | "html"> {
  const match = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/i.exec(rawHtml);
  const src = match?.[2];
  if (src === undefined || !/^\/file-read-\d+\.(?:png|jpe?g|gif|webp)$/i.test(src)) {
    throw new Error("PASTE_IMAGE_FAILED: paste image endpoint did not return a supported /file-read image tag");
  }

  return {
    src,
    html: `<img src="${src}" alt="${escapeHtml(alt)}" />`,
  };
}

function createPasteImageEndpoint(): string {
  return `/file-ajaxPasteImg-${randomBytes(6).toString("hex")}.html`;
}

function parsePasteEndpoint(endpoint: string): string {
  if (!/^\/file-ajaxPasteImg-[A-Za-z0-9]+\.html$/.test(endpoint)) {
    throw new Error("PASTE_ENDPOINT_INVALID: paste_endpoint must be like /file-ajaxPasteImg-xxxx.html");
  }
  return endpoint;
}

type ImageUploadSummary = {
  method: "POST";
  path: string;
  request_body: {
    editor: string;
    file_name: string;
    mime_type: SupportedMimeType;
    size: number;
    authentication: "zentao_auth";
  };
  requires_confirmation: true;
};

function createImageUploadSummary(
  endpoint: string,
  image: PreparedImage,
  alt: string,
): ImageUploadSummary {
  return {
    method: "POST",
    path: endpoint,
    request_body: {
      editor: `<img src="data:${image.mimeType};base64,<redacted>" alt="${escapeHtml(alt)}" />`,
      file_name: image.fileName,
      mime_type: image.mimeType,
      size: image.size,
      authentication: "zentao_auth",
    },
    requires_confirmation: true,
  };
}

function hasPasteImageUploader(client: UploadPasteImageClient): client is ZentaoRequester & PasteImageUploader {
  return typeof client.uploadPasteImage === "function";
}

function isSupportedMimeType(value: unknown): value is SupportedMimeType {
  return supportedMimeTypes.includes(value as SupportedMimeType);
}

function extensionForMimeType(mimeType: SupportedMimeType): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.replace("image/", "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export const imageToolsForTest = {
  buildEditorHtml,
  createPasteImageEndpoint,
  parsePasteEndpoint,
  parsePasteImageResponse,
};
