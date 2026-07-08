import { describe, expect, it } from "vitest";
import { endpointKeys, endpoints, renderPath } from "../src/zentao/endpoints.js";

describe("endpoint registry", () => {
  it("contains only whitelisted write endpoints", () => {
    const writes = Object.entries(endpoints).filter(([, value]) => value.method !== "GET");
    expect(writes.map(([key]) => key).sort()).toEqual([
      "createBug",
      "createBuild",
      "createStory",
      "createTask",
      "token",
      "updateBuild",
    ]);
  });

  it("renders path templates", () => {
    expect(renderPath(endpoints.projectBuilds, { project_id: 12 })).toBe("/projects/12/builds");
    expect(renderPath(endpoints.build, { id: 3 })).toBe("/builds/3");
    expect(renderPath(endpoints.createBug, { product_id: 60 })).toBe("/products/60/bugs");
    expect(renderPath(endpoints.createTask, { execution_id: 1510 })).toBe("/executions/1510/tasks");
  });

  it("fails when a required path parameter is missing", () => {
    expect(() => renderPath(endpoints.projectBuilds, {})).toThrow(/project_id/);
  });

  it("exposes stable endpoint keys", () => {
    expect(endpointKeys).toContain("productStories");
    expect(endpointKeys).toContain("taskEfforts");
  });
});
