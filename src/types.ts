// --- Extension Types ---
// Public API for just-web-fetch extension authors

/**
 * Content block in a tool result (matches Pi's content types).
 */
export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type ToolContent = TextContent | ImageContent;

/**
 * Result returned by hooks to short-circuit or replace pipeline output.
 */
export interface HookResult {
	content: ToolContent[];
	isError?: boolean;
}

/**
 * Context passed to every hook function.
 */
export interface HookContext {
	/** Normalized URL (always https://) */
	url: string;
	/** Parsed URL object */
	parsedUrl: URL;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
}

/**
 * Context for the afterFetch hook — includes fetched HTML.
 */
export interface AfterFetchHookContext extends HookContext {
	html: string;
}

/**
 * Context for the afterExtract hook — includes extracted markdown.
 */
export interface AfterExtractHookContext extends HookContext {
	markdown: string;
}

/**
 * A web-fetch extension that handles site-specific fetch behavior.
 *
 * Extensions are modules whose default export is a factory function returning
 * a WebFetchExtension object. The same interface is used for local and
 * event-bus extensions.
 *
 * @example
 * ```typescript
 * import type { WebFetchExtension } from "just-web-fetch/types";
 *
 * export default function (): WebFetchExtension {
 *   return {
 *     name: "my-handler",
 *     matches: ["example.com/**"],
 *     async beforeFetch(ctx) {
 *       return {
 *         content: [{ type: "text", text: "Use a different tool for this site." }],
 *       };
 *     },
 *   };
 * }
 * ```
 */
export interface WebFetchExtension {
	/** Unique name for the extension */
	name: string;
	/** Human-readable description */
	description?: string;
	/**
	 * URL glob patterns to match against hostname + pathname.
	 * Uses picomatch syntax: `*` matches a single segment, `**` matches multiple.
	 * @example ["example.com/**", "docs.example.com/​*​/guide/**"]
	 */
	matches: string[];

	/**
	 * Called after URL validation but before fetching.
	 * Return a HookResult to short-circuit the entire pipeline.
	 * Return void to continue with normal fetching.
	 */
	beforeFetch?(ctx: HookContext): Promise<HookResult | void>;

	/**
	 * Called after HTML is fetched via puppeteer.
	 * Return `{ html: string }` to replace the fetched HTML before extraction.
	 * Return a HookResult to short-circuit remaining pipeline.
	 * Return void to continue with the original HTML.
	 */
	afterFetch?(ctx: AfterFetchHookContext): Promise<HookResult | { html: string } | void>;

	/**
	 * Called after content is extracted to markdown by trafilatura.
	 * Return a string to replace the extracted markdown.
	 * Return a HookResult to short-circuit remaining pipeline.
	 * Return void to keep the original markdown.
	 */
	afterExtract?(ctx: AfterExtractHookContext): Promise<HookResult | string | void>;

}

/**
 * Create a HookContext for the given URL and options.
 * Used internally by just-web-fetch; exported for testing.
 */
export function createHookContext(url: string, options?: { signal?: AbortSignal }): HookContext {
	return {
		url,
		parsedUrl: new URL(url),
		signal: options?.signal,
	};
}
