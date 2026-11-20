import { describe, it, expect } from "vitest";
import { createHookContext } from "./types.js";
import type { WebFetchExtension, HookResult } from "./types.js";

describe("createHookContext", () => {
	it("creates context with normalized URL", () => {
		const ctx = createHookContext("https://example.com/page");
		expect(ctx.url).toBe("https://example.com/page");
		expect(ctx.parsedUrl.hostname).toBe("example.com");
		expect(ctx.parsedUrl.pathname).toBe("/page");
	});

	it("does not expose LLM prompt state", () => {
		const ctx = createHookContext("https://example.com");
		expect("prompt" in ctx).toBe(false);
	});

	it("includes signal when provided", () => {
		const controller = new AbortController();
		const ctx = createHookContext("https://example.com", { signal: controller.signal });
		expect(ctx.signal).toBe(controller.signal);
		expect(ctx.signal!.aborted).toBe(false);
	});

	it("signal reflects aborted state", () => {
		const controller = new AbortController();
		const ctx = createHookContext("https://example.com", { signal: controller.signal });
		controller.abort();
		expect(ctx.signal!.aborted).toBe(true);
	});
});

describe("hook context helpers", () => {
	it("does not include the removed redirect helper", () => {
		const ctx = createHookContext("https://example.com");
		expect("redirect" in ctx).toBe(false);
	});
});
