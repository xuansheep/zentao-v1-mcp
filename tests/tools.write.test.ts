import { describe, expect, it } from "vitest";
import {
  resolveCreateBugRequest,
  resolveCreateStoryRequest,
  resolveCreateTaskRequest,
} from "../src/tools/writeTools.js";

describe("create work item tools", () => {
  it("dry-runs create bug without confirm=true", async () => {
    const calls: unknown[] = [];
    const result = await resolveCreateBugRequest(
      {
        product_id: 60,
        title: "登录失败",
        severity: 2,
        pri: 1,
        type: "codeerror",
        openedBuild: ["trunk"],
      },
      async (request) => calls.push(request),
    );

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      method: "POST",
      path: "/products/60/bugs",
      requires_confirmation: true,
      request_body: {
        title: "登录失败",
        severity: 2,
        pri: 1,
        type: "codeerror",
        openedBuild: ["trunk"],
      },
    });
  });

  it("sends create bug when confirmed and excludes control fields from body", async () => {
    const calls: unknown[] = [];
    await resolveCreateBugRequest(
      {
        product_id: 60,
        title: "登录失败",
        severity: 2,
        pri: 1,
        type: "codeerror",
        branch: 0,
        module: 0,
        execution: 1510,
        keywords: "login",
        os: "linux",
        browser: "chrome",
        steps: "",
        task: 456,
        story: 123,
        deadline: "2026-07-31",
        openedBuild: ["trunk"],
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/products/60/bugs",
      body: {
        title: "登录失败",
        severity: 2,
        pri: 1,
        type: "codeerror",
        branch: 0,
        module: 0,
        execution: 1510,
        keywords: "login",
        os: "linux",
        browser: "chrome",
        steps: "",
        task: 456,
        story: 123,
        deadline: "2026-07-31",
        openedBuild: ["trunk"],
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain("product_id");
    expect(JSON.stringify(calls[0])).not.toContain("confirm");
  });

  it("rejects unsupported bug type", () => {
    expect(() =>
      resolveCreateBugRequest(
        {
          product_id: 60,
          title: "登录失败",
          severity: 2,
          pri: 1,
          type: "bad-type",
          confirm: true,
        },
        async () => undefined,
      ),
    ).toThrow();
  });

  it("dry-runs create task without confirm=true", async () => {
    const calls: unknown[] = [];
    const result = await resolveCreateTaskRequest(
      {
        execution_id: 1510,
        name: "实现登录接口",
        type: "devel",
        assignedTo: "admin",
        estStarted: "2026-07-09",
        deadline: "2026-07-31",
      },
      async (request) => calls.push(request),
    );

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      method: "POST",
      path: "/executions/1510/tasks",
      requires_confirmation: true,
      request_body: {
        name: "实现登录接口",
        type: "devel",
        assignedTo: "admin",
        estStarted: "2026-07-09",
        deadline: "2026-07-31",
      },
    });
  });

  it("sends create task when confirmed and excludes execution_id", async () => {
    const calls: unknown[] = [];
    await resolveCreateTaskRequest(
      {
        execution_id: 1510,
        module: 0,
        story: 123,
        fromBug: 456,
        name: "实现登录接口",
        type: "devel",
        assignedTo: "admin",
        pri: 2,
        estimate: 3.5,
        estStarted: "2026-07-09",
        deadline: "2026-07-31",
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/executions/1510/tasks",
      body: {
        module: 0,
        story: 123,
        fromBug: 456,
        name: "实现登录接口",
        type: "devel",
        assignedTo: "admin",
        pri: 2,
        estimate: 3.5,
        estStarted: "2026-07-09",
        deadline: "2026-07-31",
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain("execution_id");
    expect(JSON.stringify(calls[0])).not.toContain("confirm");
  });

  it("rejects unsupported task type", () => {
    expect(() =>
      resolveCreateTaskRequest(
        {
          execution_id: 1510,
          name: "实现登录接口",
          type: "bad-type",
          assignedTo: "admin",
          estStarted: "2026-07-09",
          deadline: "2026-07-31",
          confirm: true,
        },
        async () => undefined,
      ),
    ).toThrow();
  });

  it("dry-runs create story without confirm=true", async () => {
    const calls: unknown[] = [];
    const result = await resolveCreateStoryRequest(
      {
        title: "支持短信登录",
        product: 60,
        pri: 2,
        category: "feature",
      },
      async (request) => calls.push(request),
    );

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      method: "POST",
      path: "/stories",
      requires_confirmation: true,
      request_body: {
        title: "支持短信登录",
        product: 60,
        pri: 2,
        category: "feature",
      },
    });
  });

  it("sends create story when confirmed", async () => {
    const calls: unknown[] = [];
    await resolveCreateStoryRequest(
      {
        title: "支持短信登录",
        product: 60,
        pri: 2,
        category: "feature",
        spec: "",
        verify: "可以通过短信验证码登录",
        source: "po",
        sourceNote: "产品规划",
        estimate: 5,
        keywords: "login,sms",
        confirm: true,
      },
      async (request) => calls.push(request),
    );

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/stories",
      body: {
        title: "支持短信登录",
        product: 60,
        pri: 2,
        category: "feature",
        spec: "",
        verify: "可以通过短信验证码登录",
        source: "po",
        sourceNote: "产品规划",
        estimate: 5,
        keywords: "login,sms",
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain("confirm");
  });

  it("rejects unsupported story category", () => {
    expect(() =>
      resolveCreateStoryRequest(
        {
          title: "支持短信登录",
          product: 60,
          pri: 2,
          category: "bad-category",
          confirm: true,
        },
        async () => undefined,
      ),
    ).toThrow();
  });
});
