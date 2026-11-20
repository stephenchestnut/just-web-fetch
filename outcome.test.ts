import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { buildToolResult, outcomeToStructured, STRUCTURED_RESULT_SCHEMA, type PageOutcome } from "./outcome.js";
import type { ExtractedPage } from "./result.js";

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

const fulfilled = (value: PageOutcome): PromiseSettledResult<PageOutcome> => ({ status: "fulfilled", value });

describe("outcomeToStructured", () => {
	it("includes complete Markdown and metadata for fetched pages", () => {
		const structured = outcomeToStructured("http://example.com", {
			status: "fetched",
			cached: true,
			page: page("# Title\nline two", {
				finalUrl: "https://www.example.com/",
				redirectChain: ["https://example.com/", "https://www.example.com/"],
				blockedRequests: [{ url: "https://127.0.0.1/", reason: "private" }],
			}),
		});
		expect(structured).toEqual({
			status: "fetched",
			requestedUrl: "http://example.com",
			url: "https://example.com/",
			finalUrl: "https://www.example.com/",
			redirectChain: ["https://example.com/", "https://www.example.com/"],
			markdown: "# Title\nline two",
			savedPath: "/tmp/saved.md",
			bytes: 16,
			lines: 2,
			blockedRequests: [{ url: "https://127.0.0.1/", reason: "private" }],
			cached: true,
		});
	});

	it("reports a missing saved file as null with the reason", () => {
		const structured = outcomeToStructured("https://example.com/", {
			status: "fetched",
			cached: false,
			page: page("x", { savedPath: undefined, saveError: "disk full" }),
		});
		expect(structured).toMatchObject({ savedPath: null, saveError: "disk full" });
	});

	it("counts multibyte characters as UTF-8 bytes", () => {
		const structured = outcomeToStructured("https://example.com/", { status: "fetched", cached: false, page: page("é") });
		expect(structured).toMatchObject({ bytes: 2, lines: 1 });
	});

	it("reports extension results with the extension name", () => {
		const structured = outcomeToStructured("https://example.com/", {
			status: "extension",
			url: "https://example.com/",
			extension: "my-handler",
			result: { content: [{ type: "text", text: "Use another tool" }], isError: true },
		});
		expect(structured).toEqual({
			status: "extension",
			requestedUrl: "https://example.com/",
			url: "https://example.com/",
			extension: "my-handler",
			text: "Use another tool",
			isError: true,
		});
	});
});

describe("buildToolResult", () => {
	it("returns text for the model and structured pages in request order", () => {
		const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
		const pages = [{ url: "https://a.example/" }, { url: "https://localhost/" }, { url: "https://b.example/" }];
		const result = buildToolResult(pages, [
			fulfilled({ status: "fetched", cached: false, page: page(big) }),
			fulfilled({ status: "error", error: "Blocked navigation to https://localhost/" }),
			{ status: "rejected", reason: new Error("unexpected") },
		]);

		const text = result.content[0].text as string;
		expect(text).toContain("--- [1/3] https://a.example/ ---");
		expect(text).toContain("PREVIEW ONLY");
		expect(text).toContain("Error: Blocked navigation to https://localhost/");

		expect(result.structuredContent.pages.map((p) => p.status)).toEqual(["fetched", "error", "error"]);
		const first = result.structuredContent.pages[0];
		expect(first.status === "fetched" && first.markdown).toBe(big);
		expect(result.structuredContent.pages[2]).toEqual({ status: "error", requestedUrl: "https://b.example/", error: "unexpected" });
	});

	it("marks a failed single page as an error while keeping structured content", () => {
		const result = buildToolResult([{ url: "https://localhost/" }], [fulfilled({ status: "error", error: "Blocked" })]);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Blocked");
		expect(result.structuredContent.pages).toEqual([{ status: "error", requestedUrl: "https://localhost/", error: "Blocked" }]);
	});

	it("produces structured content matching the declared output schema", () => {
		const result = buildToolResult(
			[{ url: "https://a.example/" }, { url: "https://bad/" }, { url: "https://c.example/" }],
			[
				fulfilled({ status: "fetched", cached: false, page: page("content", { savedPath: undefined, saveError: "x" }) }),
				fulfilled({ status: "error", error: "failed" }),
				fulfilled({
					status: "extension",
					url: "https://c.example/",
					extension: "ext",
					result: { content: [{ type: "text", text: "hi" }] },
				}),
			],
		);
		expect(Value.Check(STRUCTURED_RESULT_SCHEMA, result.structuredContent)).toBe(true);
	});
});
