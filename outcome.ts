/**
 * Per-page outcomes and the tool results built from them.
 *
 * Every web_fetch call returns both:
 *   - `content`: text for the model (complete Markdown or a marked preview), and
 *   - `structuredContent`: data for programmatic callers such as codemode scripts,
 *     including each page's complete Markdown.
 */
import { Type } from "@sinclair/typebox";
import type { HookResult } from "./types.js";
import { batchBudget, formatPageResult, type ExtractedPage, type FormatOptions } from "./result.js";

/** Result of running one URL through the pipeline. */
export type PageOutcome =
	| { status: "fetched"; page: ExtractedPage; cached: boolean }
	| { status: "error"; error: string }
	| { status: "extension"; url: string; extension: string; result: HookResult };

/** Structured result for one requested page. */
export type StructuredPage =
	| {
			status: "fetched";
			/** URL exactly as passed in the request. */
			requestedUrl: string;
			/** Normalized URL that was fetched. */
			url: string;
			finalUrl: string;
			/** Main-frame navigation URLs, starting with `url`. */
			redirectChain: string[];
			/** Complete extracted Markdown, never truncated or summarized. */
			markdown: string;
			/** Absolute path of the saved Markdown file, or null if saving failed. */
			savedPath: string | null;
			saveError?: string;
			bytes: number;
			lines: number;
			blockedRequests: Array<{ url: string; reason: string }>;
			/** Whether the result came from the short-lived cache. */
			cached: boolean;
	  }
	| { status: "error"; requestedUrl: string; error: string }
	| {
			status: "extension";
			requestedUrl: string;
			url: string;
			/** Name of the extension hook that produced the result. */
			extension: string;
			text: string;
			isError: boolean;
	  };

export interface StructuredResult {
	pages: StructuredPage[];
}

/** JSON Schema for `StructuredResult`, declared as the tool's outputSchema. */
export const STRUCTURED_RESULT_SCHEMA = Type.Object({
	pages: Type.Array(
		Type.Union([
			Type.Object({
				status: Type.Literal("fetched"),
				requestedUrl: Type.String({ description: "URL exactly as passed in the request" }),
				url: Type.String({ description: "Normalized URL that was fetched" }),
				finalUrl: Type.String({ description: "URL after redirects" }),
				redirectChain: Type.Array(Type.String(), { description: "Navigation URLs, starting with url" }),
				markdown: Type.String({ description: "Complete extracted Markdown, never truncated or summarized" }),
				savedPath: Type.Union([Type.String(), Type.Null()], { description: "Saved Markdown file, or null if saving failed" }),
				saveError: Type.Optional(Type.String()),
				bytes: Type.Number({ description: "Size of markdown in UTF-8 bytes" }),
				lines: Type.Number({ description: "Number of lines in markdown" }),
				blockedRequests: Type.Array(Type.Object({ url: Type.String(), reason: Type.String() }), {
					description: "Subresource requests blocked by the network policy",
				}),
				cached: Type.Boolean({ description: "Whether the result came from the short-lived cache" }),
			}),
			Type.Object({
				status: Type.Literal("error"),
				requestedUrl: Type.String(),
				error: Type.String(),
			}),
			Type.Object({
				status: Type.Literal("extension"),
				requestedUrl: Type.String(),
				url: Type.String(),
				extension: Type.String({ description: "Extension hook that produced the result" }),
				text: Type.String(),
				isError: Type.Boolean(),
			}),
		]),
		{ description: "One entry per requested URL, in request order" },
	),
});

export interface ToolResultShape {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError?: boolean;
}

function hookText(result: HookResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function errorMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/** Model-facing tool result for one outcome. */
export function outcomeToToolResult(outcome: PageOutcome, format: FormatOptions = {}): ToolResultShape {
	switch (outcome.status) {
		case "fetched":
			return { content: [{ type: "text", text: formatPageResult(outcome.page, format) }] };
		case "error":
			return { content: [{ type: "text", text: outcome.error }], isError: true };
		case "extension":
			return outcome.result as ToolResultShape;
	}
}

/** Structured result for one outcome. */
export function outcomeToStructured(requestedUrl: string, outcome: PageOutcome): StructuredPage {
	switch (outcome.status) {
		case "fetched": {
			const { page } = outcome;
			return {
				status: "fetched",
				requestedUrl,
				url: page.requestedUrl,
				finalUrl: page.finalUrl,
				redirectChain: page.redirectChain,
				markdown: page.markdown,
				savedPath: page.savedPath ?? null,
				...(page.saveError ? { saveError: page.saveError } : {}),
				bytes: Buffer.byteLength(page.markdown, "utf-8"),
				lines: page.markdown.length === 0 ? 0 : page.markdown.split("\n").length,
				blockedRequests: page.blockedRequests.map(({ url, reason }) => ({ url, reason })),
				cached: outcome.cached,
			};
		}
		case "error":
			return { status: "error", requestedUrl, error: outcome.error };
		case "extension":
			return {
				status: "extension",
				requestedUrl,
				url: outcome.url,
				extension: outcome.extension,
				text: hookText(outcome.result),
				isError: outcome.result.isError === true,
			};
	}
}

/**
 * Format batch results into a single text content block with per-page headers.
 * A single page is returned without the batch wrapper.
 */
export function formatBatchResults(pages: Array<{ url: string }>, results: PromiseSettledResult<any>[]) {
	const total = pages.length;

	if (total === 1) {
		const settled = results[0];
		if (settled.status === "rejected") {
			return {
				content: [{ type: "text", text: `Error: ${settled.reason?.message || String(settled.reason)}` }],
				isError: true,
			};
		}
		return settled.value;
	}

	const sections: string[] = [];
	for (let i = 0; i < total; i++) {
		const header = `--- [${i + 1}/${total}] ${pages[i].url} ---`;
		const settled = results[i];

		let body: string;
		if (settled.status === "rejected") {
			body = `Error: ${settled.reason?.message || String(settled.reason)}`;
		} else {
			const result = settled.value;
			const textContent = result.content?.[0];
			if (result.isError) {
				body = `Error: ${textContent?.type === "text" ? textContent.text : "Unknown error"}`;
			} else {
				body = textContent?.type === "text" ? textContent.text : "(no content)";
			}
		}
		sections.push(`${header}\n${body}`);
	}

	return { content: [{ type: "text", text: sections.join("\n\n") }] };
}

/**
 * Build the complete tool result for a batch: model-facing text plus structured
 * content. Pages share the inline output budget; structured Markdown is complete.
 */
export function buildToolResult(pages: Array<{ url: string }>, outcomes: PromiseSettledResult<PageOutcome>[]) {
	const format: FormatOptions = pages.length === 1 ? {} : batchBudget(pages.length);
	const textResults: PromiseSettledResult<ToolResultShape>[] = outcomes.map((settled) =>
		settled.status === "fulfilled" ? { status: "fulfilled", value: outcomeToToolResult(settled.value, format) } : settled,
	);
	const structured: StructuredResult = {
		pages: outcomes.map((settled, i) =>
			settled.status === "fulfilled"
				? outcomeToStructured(pages[i].url, settled.value)
				: { status: "error", requestedUrl: pages[i].url, error: errorMessage(settled.reason) },
		),
	};

	return { ...formatBatchResults(pages, textResults), structuredContent: structured };
}
