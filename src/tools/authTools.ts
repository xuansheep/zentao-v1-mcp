import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { ensureConfirmed } from "../safety.js";
import {
  defaultImageUploadAuthPath,
  type ImageUploadAuthInfo,
  type ImageUploadAuthResult,
} from "../zentao/imageUploadAuth.js";
import type { McpServerLike, ZentaoRequester } from "./queryTools.js";

type ImageUploadAuthenticator = {
  imageUploadAuthInfo(): ImageUploadAuthInfo;
  authenticateImageUpload(): Promise<ImageUploadAuthResult>;
};

type AuthToolClient = ZentaoRequester & Partial<ImageUploadAuthenticator>;

const authInputSchema = z
  .object({
    confirm: z
      .boolean()
      .optional()
      .describe("Must be true to open the browser and persist ZenTao image upload authentication."),
  })
  .strict();

type AuthSummary = {
  action: "refresh_image_upload_auth";
  storage_path: string;
  base_url?: string;
  requires_confirmation: true;
};

export async function resolveAuthRequest(
  args: unknown,
  client: AuthToolClient,
): Promise<AuthSummary | ImageUploadAuthResult> {
  const parsed = authInputSchema.parse(args);
  const info =
    typeof client.imageUploadAuthInfo === "function"
      ? client.imageUploadAuthInfo()
      : undefined;

  if (!ensureConfirmed(parsed.confirm)) {
    return {
      action: "refresh_image_upload_auth",
      storage_path: info?.storage_path ?? defaultImageUploadAuthPath(),
      ...(info === undefined ? {} : { base_url: info.base_url }),
      requires_confirmation: true,
    };
  }

  if (typeof client.authenticateImageUpload !== "function") {
    throw new Error(
      "IMAGE_UPLOAD_AUTH_FAILED: configured ZenTao client does not support image upload authentication",
    );
  }
  return client.authenticateImageUpload();
}

export function registerAuthTools(
  server: McpServerLike,
  client: AuthToolClient,
): void {
  server.tool(
    "zentao_auth",
    "Open a browser to authenticate ZenTao image uploads and persist the session in ~/.zentao/auth.json. Without confirm=true, returns a dry-run summary.",
    authInputSchema.shape,
    async (args) => jsonText(await resolveAuthRequest(args, client)),
  );
}
