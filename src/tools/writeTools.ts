import { z } from "zod";
import { jsonText } from "../mcp/result.js";
import { createWriteSummary, ensureConfirmed } from "../safety.js";
import { endpoints, renderPath } from "../zentao/endpoints.js";
import type { McpServerLike, ToolRequest, ZentaoRequester } from "./queryTools.js";

type Dispatch = (request: ToolRequest) => Promise<unknown> | unknown;

const bugTypeSchema = z.enum([
  "codeerror",
  "config",
  "install",
  "security",
  "performance",
  "standard",
  "automation",
  "designdefect",
  "others",
]);

const taskTypeSchema = z.enum([
  "design",
  "devel",
  "request",
  "test",
  "study",
  "discuss",
  "ui",
  "affair",
  "misc",
]);

const storyCategorySchema = z.enum([
  "feature",
  "interface",
  "performance",
  "safe",
  "experience",
  "improve",
  "other",
]);

const storySourceSchema = z.enum(["customer", "user", "po", "market"]);

const nonEmptyString = z.string().min(1);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const nonNegativeNumber = z.number().nonnegative();

const createBugSchema = z.object({
  product_id: positiveInt.describe("ZenTao product ID."),
  branch: nonNegativeInt.optional().describe("ZenTao product branch ID; 0 is the main branch."),
  module: nonNegativeInt.optional().describe("ZenTao product module ID; 0 means no module."),
  execution: positiveInt.optional().describe("ZenTao execution ID."),
  title: nonEmptyString.describe("Bug title."),
  keywords: nonEmptyString.optional().describe("Bug keywords."),
  severity: positiveInt.describe("Bug severity."),
  pri: positiveInt.describe("Bug priority."),
  type: bugTypeSchema.describe("Bug type."),
  os: nonEmptyString.optional().describe("Operating system."),
  browser: nonEmptyString.optional().describe("Browser."),
  steps: z.string().optional().describe("Reproduction steps."),
  task: positiveInt.optional().describe("Related task ID."),
  story: positiveInt.optional().describe("Related story ID."),
  deadline: nonEmptyString.optional().describe("Bug deadline accepted by ZenTao."),
  openedBuild: z.array(nonEmptyString).optional().describe("Affected build names."),
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

const createTaskSchema = z.object({
  execution_id: positiveInt.describe("ZenTao execution ID."),
  module: nonNegativeInt.optional().describe("ZenTao execution module ID; 0 means no module."),
  story: positiveInt.optional().describe("Related story ID."),
  fromBug: positiveInt.optional().describe("Source bug ID."),
  name: nonEmptyString.describe("Task name."),
  type: taskTypeSchema.describe("Task type."),
  assignedTo: nonEmptyString.describe("Assignee account."),
  pri: positiveInt.optional().describe("Task priority."),
  estimate: nonNegativeNumber.optional().describe("Estimated hours."),
  estStarted: nonEmptyString.describe("Estimated start date accepted by ZenTao."),
  deadline: nonEmptyString.describe("Task deadline accepted by ZenTao."),
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

const createStorySchema = z.object({
  title: nonEmptyString.describe("Story title."),
  product: positiveInt.describe("ZenTao product ID."),
  pri: positiveInt.describe("Story priority."),
  category: storyCategorySchema.describe("Story category."),
  spec: z.string().optional().describe("Story description."),
  verify: z.string().optional().describe("Acceptance criteria."),
  source: storySourceSchema.optional().describe("Story source."),
  sourceNote: nonEmptyString.optional().describe("Story source note."),
  estimate: nonNegativeNumber.optional().describe("Estimated hours."),
  keywords: nonEmptyString.optional().describe("Story keywords."),
  confirm: z.boolean().optional().describe("Must be true to send the write request."),
});

type CreateBugArgs = z.infer<typeof createBugSchema>;
type CreateTaskArgs = z.infer<typeof createTaskSchema>;
type CreateStoryArgs = z.infer<typeof createStorySchema>;

const createBugFieldNames = [
  "branch",
  "module",
  "execution",
  "title",
  "keywords",
  "severity",
  "pri",
  "type",
  "os",
  "browser",
  "steps",
  "task",
  "story",
  "deadline",
  "openedBuild",
] as const;

const createTaskFieldNames = [
  "module",
  "story",
  "fromBug",
  "name",
  "type",
  "assignedTo",
  "pri",
  "estimate",
  "estStarted",
  "deadline",
] as const;

const createStoryFieldNames = [
  "title",
  "product",
  "pri",
  "category",
  "spec",
  "verify",
  "source",
  "sourceNote",
  "estimate",
  "keywords",
] as const;

export function resolveCreateBugRequest(args: CreateBugArgs, dispatch: Dispatch) {
  const parsed = createBugSchema.parse(args);
  const path = renderPath(endpoints.createBug, { product_id: parsed.product_id });
  const body = pickDefined(parsed, createBugFieldNames);
  const request = { method: endpoints.createBug.method, path, body };

  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function resolveCreateTaskRequest(args: CreateTaskArgs, dispatch: Dispatch) {
  const parsed = createTaskSchema.parse(args);
  const path = renderPath(endpoints.createTask, { execution_id: parsed.execution_id });
  const body = pickDefined(parsed, createTaskFieldNames);
  const request = { method: endpoints.createTask.method, path, body };

  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function resolveCreateStoryRequest(args: CreateStoryArgs, dispatch: Dispatch) {
  const parsed = createStorySchema.parse(args);
  const body = pickDefined(parsed, createStoryFieldNames);
  const request = { method: endpoints.createStory.method, path: endpoints.createStory.path, body };

  if (!ensureConfirmed(parsed.confirm)) {
    return createWriteSummary(request);
  }

  return dispatch(request);
}

export function registerWriteTools(server: McpServerLike, client: ZentaoRequester): void {
  server.tool(
    "zentao_create_bug",
    "Create a ZenTao bug. Without confirm=true, returns a dry-run summary instead of writing.",
    createBugSchema.shape,
    async (args) =>
      jsonText(await resolveCreateBugRequest(args as CreateBugArgs, (request) => client.request(request))),
  );

  server.tool(
    "zentao_create_task",
    "Create a ZenTao task. Without confirm=true, returns a dry-run summary instead of writing.",
    createTaskSchema.shape,
    async (args) =>
      jsonText(await resolveCreateTaskRequest(args as CreateTaskArgs, (request) => client.request(request))),
  );

  server.tool(
    "zentao_create_story",
    "Create a ZenTao story. Without confirm=true, returns a dry-run summary instead of writing.",
    createStorySchema.shape,
    async (args) =>
      jsonText(await resolveCreateStoryRequest(args as CreateStoryArgs, (request) => client.request(request))),
  );
}

function pickDefined<T extends Record<string, unknown>, K extends readonly (keyof T)[]>(
  value: T,
  keys: K,
): Partial<Pick<T, K[number]>> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as Partial<Pick<T, K[number]>>;
}
