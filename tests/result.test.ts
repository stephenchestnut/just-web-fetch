import { describe, expect, it } from "vitest";
import { batchBudget, formatPageResult, type ExtractedPage } from "../src/result.js";

function page(markdown: string, overrides: Partial<ExtractedPage> = {}): ExtractedPage {
	return {
		requestedUrl: "https://example.com/",
		finalUrl: "https://example.com/",
		redirectChain: ["https://example.com/"],
		blockedRequests: [],
		markdown,
		savedPath: "/tmp/saved.md",
		...overrides,
	};
}

describe("formatPageResult", () => {
	it("returns complete Markdown and the saved path for small pages", () => {
		const text = formatPageResult(page("# Small\n\nAll content"));
		expect(text).toContain("Source: https://example.com/");
		expect(text).toContain("Saved: /tmp/saved.md");
		expect(text).toContain("Content: complete");
		expect(text.endsWith("# Small\n\nAll content")).toBe(true);
	});

	it("returns a clearly marked preview for large pages and never summarizes", () => {
		const markdown = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
		const text = formatPageResult(page(markdown), { maxBytes: 1000, maxLines: 50 });
		expect(text).toContain("Content: PREVIEW ONLY");
		expect(text).toContain("of 500 lines");
		expect(text).toContain("Complete extraction saved to: /tmp/saved.md");
		expect(text).toContain("line 0");
		expect(text).not.toContain("line 499");
	});

	it("reports requested URL and redirect chain when redirected", () => {
		const text = formatPageResult(
			page("content", {
				requestedUrl: "https://short.example/a",
				finalUrl: "https://docs.example/final",
				redirectChain: ["https://short.example/a", "https://docs.example/final"],
			}),
		);
		expect(text).toContain("Source: https://docs.example/final");
		expect(text).toContain("Requested: https://short.example/a");
		expect(text).toContain("Redirects: https://short.example/a → https://docs.example/final");
	});

	it("reports blocked subresource requests", () => {
		const text = formatPageResult(
			page("content", { blockedRequests: [{ url: "https://127.0.0.1/api", reason: "127.0.0.1 is a local or private address" }] }),
		);
		expect(text).toContain("Blocked requests: 1");
		expect(text).toContain("https://127.0.0.1/api");
	});

	it("explains when the complete extraction could not be saved", () => {
		const markdown = "x".repeat(5000);
		const text = formatPageResult(page(markdown, { savedPath: undefined, saveError: "disk full" }), { maxBytes: 1000 });
		expect(text).toContain("Saved: no — disk full");
		expect(text).toContain("Complete extraction could not be saved");
	});
});

describe("batchBudget", () => {
	it("shares the inline output limit across pages", () => {
		const one = batchBudget(1);
		const four = batchBudget(4);
		expect(four.maxBytes).toBe(Math.floor(one.maxBytes / 4));
		expect(four.maxLines).toBe(Math.floor(one.maxLines / 4));
	});
});
