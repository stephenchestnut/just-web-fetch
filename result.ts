/**
 * Tool result formatting for extracted pages.
 */
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import type { BlockedRequest } from "./fetch-page.js";

/** Maximum preview size when a page is too large to return inline. */
export const PREVIEW_MAX_BYTES = 4 * 1024;
export const PREVIEW_MAX_LINES = 100;
/** Maximum blocked requests listed in a result. */
const MAX_LISTED_BLOCKED_REQUESTS = 5;

export interface ExtractedPage {
	requestedUrl: string;
	finalUrl: string;
	redirectChain: string[];
	blockedRequests: BlockedRequest[];
	markdown: string;
	/** Absolute path of the complete saved Markdown, if saving succeeded. */
	savedPath?: string;
	/** Error explaining why the page could not be saved. */
	saveError?: string;
}

export interface FormatOptions {
	/** Inline content budget in bytes. Defaults to Pi's normal tool output limit. */
	maxBytes?: number;
	/** Inline content budget in lines. Defaults to Pi's normal tool output limit. */
	maxLines?: number;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/** Inline budgets for each page in a batch, sharing Pi's normal output limit. */
export function batchBudget(pageCount: number): Required<FormatOptions> {
	const count = Math.max(1, pageCount);
	return {
		maxBytes: Math.floor(DEFAULT_MAX_BYTES / count),
		maxLines: Math.floor(DEFAULT_MAX_LINES / count),
	};
}

/**
 * Format a page as metadata followed by complete content or a clearly marked
 * preview. Large content is never summarized.
 */
export function formatPageResult(page: ExtractedPage, options: FormatOptions = {}): string {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const totalBytes = byteLength(page.markdown);
	const totalLines = lineCount(page.markdown);
	const complete = totalBytes <= maxBytes && totalLines <= maxLines;

	const header: string[] = [`Source: ${page.finalUrl}`];
	if (page.requestedUrl !== page.finalUrl) header.push(`Requested: ${page.requestedUrl}`);
	if (page.redirectChain.length > 1) header.push(`Redirects: ${page.redirectChain.join(" → ")}`);

	if (page.savedPath) {
		header.push(`Saved: ${page.savedPath} (${formatSize(totalBytes)}, ${totalLines} lines)`);
	} else if (page.saveError) {
		header.push(`Saved: no — ${page.saveError}`);
	}

	if (page.blockedRequests.length > 0) {
		const listed = page.blockedRequests.slice(0, MAX_LISTED_BLOCKED_REQUESTS);
		header.push(`Blocked requests: ${page.blockedRequests.length}${page.blockedRequests.length > listed.length ? "+" : ""}`);
		for (const blocked of listed) header.push(`  - ${blocked.url} (${blocked.reason})`);
	}

	let body: string;
	if (complete) {
		header.push("Content: complete");
		body = page.markdown;
	} else {
		const preview = truncateHead(page.markdown, {
			maxBytes: Math.min(PREVIEW_MAX_BYTES, maxBytes),
			maxLines: Math.min(PREVIEW_MAX_LINES, maxLines),
		});
		const where = page.savedPath
			? `Complete extraction saved to: ${page.savedPath}`
			: "Complete extraction could not be saved; refetch the page to retry.";
		header.push(
			`Content: PREVIEW ONLY — first ${preview.outputLines} of ${totalLines} lines ` +
				`(${formatSize(preview.outputBytes)} of ${formatSize(totalBytes)}). ${where}`,
		);
		body = preview.content;
	}

	return `${header.join("\n")}\n\n---\n\n${body}`;
}
