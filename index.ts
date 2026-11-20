import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Text, Markdown, Container } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { BrowserPool } from "./browser-pool.js";
import { fetchPage, PAGE_TIMEOUT_MS, type FetchedPage } from "./fetch-page.js";
import { batchBudget, formatPageResult, type ExtractedPage, type FormatOptions } from "./result.js";
import { cleanupSessionDirectories, DEFAULT_RETENTION_DAYS, EPHEMERAL_RETENTION_DAYS, FetchStore } from "./storage.js";

// Re-export public types for extension authors
export type {
	WebFetchExtension,
	HookContext,
	HookResult,
	AfterFetchHookContext,
	AfterExtractHookContext,
	ToolContent,
} from "./types.js";

import type {
	WebFetchExtension,
	HookContext,
	HookResult,
	AfterFetchHookContext,
	AfterExtractHookContext,
} from "./types.js";
import { createHookContext } from "./types.js";
import { ExtensionRegistry } from "./registry.js";

// --- Config ---

interface WebFetchConfig {
	/** Directory for local extensions. Defaults to <agent-dir>/just-web-fetch/extensions/ */
	extensionsDir?: string;
	/** Delete saved session directories unused for this many days. Defaults to 30; 0 disables cleanup. */
	retentionDays?: number;
}

const AGENT_DIR = getAgentDir();
const DATA_DIR = join(AGENT_DIR, "just-web-fetch");
const CONFIG_PATH = join(AGENT_DIR, "just-web-fetch.json");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const EPHEMERAL_DIR = join(DATA_DIR, "ephemeral");

/** Expand a leading ~ in a configured path. */
function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function loadConfig(): WebFetchConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		return JSON.parse(raw) as WebFetchConfig;
	} catch {
		return {};
	}
}

const config: WebFetchConfig = loadConfig();

const registry = new ExtensionRegistry();
const MAX_BROWSER_TABS = 6; // Maximum concurrent browser tabs for parallel fetching
const BROWSER_IDLE_TIMEOUT_MS = 60_000; // Close browser after 60s idle
const browserPool = new BrowserPool({ maxTabs: MAX_BROWSER_TABS, idleTimeoutMs: BROWSER_IDLE_TIMEOUT_MS });

// --- Extension Loading ---

type NotifyFn = (message: string, level: "info" | "warning" | "error") => void;

/**
 * Load local extensions from a user directory.
 */
async function loadLocalExtensions(extensionsDir: string, notify: NotifyFn): Promise<void> {
	if (!existsSync(extensionsDir)) {
		return;
	}

	const files = readdirSync(extensionsDir).filter(
		(f) => f.endsWith(".ts") || f.endsWith(".js"),
	);

	for (const file of files) {
		try {
			const modulePath = join(extensionsDir, file);
			const mod = await import(modulePath);
			const factory = mod.default;
			if (typeof factory !== "function") {
				notify(`web-fetch: local extension ${file} has no default export function, skipping`, "warning");
				continue;
			}
			const ext: WebFetchExtension = factory();
			if (!ext.name || !ext.matches) {
				notify(`web-fetch: local extension ${file} missing name or matches, skipping`, "warning");
				continue;
			}
			registry.addLocal(ext);
		} catch (err: any) {
			notify(`web-fetch: failed to load local extension ${file}: ${err.message}`, "error");
		}
	}
}

/**
 * Set up event bus registration for Pi extensions.
 * Subscribes to web-fetch:register and validates incoming payloads.
 */
function setupEventBusRegistration(pi: ExtensionAPI): void {
	pi.events.on("web-fetch:register", (data: unknown) => {
		const ext = data as WebFetchExtension;
		if (!ext || typeof ext !== "object") {
			console.error("web-fetch: received invalid registration on web-fetch:register (not an object)");
			return;
		}
		if (!ext.name || !ext.matches || !Array.isArray(ext.matches)) {
			console.error("web-fetch: received registration missing required fields (name, matches)");
			return;
		}
		registry.addEventBus(ext);
	});
}

// --- Constants ---

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const EXTRACT_TIMEOUT_MS = 10_000; // 10 seconds for trafilatura extraction
export const MAX_BATCH_SIZE = 10; // Maximum pages in a single batch call

// --- Batch Status Types ---

type BatchPageStatus = "pending" | "fetching" | "extracting" | "done" | "error";

interface BatchPageState {
	url: string;
	status: BatchPageStatus;
	error?: string;
}

interface BatchDetails {
	pages: BatchPageState[];
}

// --- Cache ---

interface CacheEntry {
	page: ExtractedPage;
	timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(url: string): ExtractedPage | null {
	const entry = cache.get(url);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
		cache.delete(url);
		return null;
	}
	return entry.page;
}

function setCache(url: string, page: ExtractedPage): void {
	cache.set(url, { page, timestamp: Date.now() });
}

function cleanupCache(): void {
	const now = Date.now();
	for (const [url, entry] of cache) {
		if (now - entry.timestamp > CACHE_TTL_MS) {
			cache.delete(url);
		}
	}
}

// --- URL Helpers ---

function validateAndNormalizeUrl(raw: string): { url: string; error?: undefined } | { url?: undefined; error: string } {
	// Strip leading @ (some models add it)
	const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;

	let parsed: URL;
	try {
		parsed = new URL(cleaned);
	} catch {
		return { error: `Invalid URL: "${cleaned}". Please provide a fully-formed URL (e.g., https://example.com/page).` };
	}

	if (parsed.protocol === "http:") {
		parsed.protocol = "https:";
	}

	if (parsed.protocol !== "https:") {
		return { error: `Unsupported URL scheme: "${parsed.protocol}". Only HTTP and HTTPS URLs are supported.` };
	}

	return { url: parsed.toString() };
}

// --- Subprocess Helpers ---

function killProcess(proc: ReturnType<typeof spawn>): void {
	proc.kill("SIGTERM");
	setTimeout(() => {
		if (!proc.killed) proc.kill("SIGKILL");
	}, 5000);
}

/**
 * Race a promise against a timeout. Returns the promise result or rejects with a timeout error.
 * If a signal is provided, the timeout is also cancelled when the signal aborts.
 */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms / 1000} seconds`));
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		promise.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

// --- Python Runner Detection ---

interface PythonRunner {
	command: string;
	/** Arguments to build the full trafilatura invocation */
	trafilaturaArgs: () => string[];
	label: string;
}

/**
 * Python tool runners in priority order.
 * Each can run trafilatura in an ephemeral environment without permanent installation.
 *
 *  1. uvx           — fastest, ships with uv (uvx trafilatura ...)
 *  2. uv run --with — fallback if uvx alias is missing but uv is installed
 *  3. pipx run      — widely available, especially on Debian/Ubuntu
 *  4. pip-run       — niche but capable (pip-run trafilatura -- -m trafilatura ...)
 */
const PYTHON_RUNNERS: PythonRunner[] = [
	{
		command: "uvx",
		trafilaturaArgs: () => ["trafilatura", "--markdown", "--formatting"],
		label: "uvx (uv)",
	},
	{
		command: "uv",
		trafilaturaArgs: () => ["run", "--with", "trafilatura", "trafilatura", "--markdown", "--formatting"],
		label: "uv run",
	},
	{
		command: "pipx",
		trafilaturaArgs: () => ["run", "trafilatura", "--markdown", "--formatting"],
		label: "pipx",
	},
	{
		command: "pip-run",
		trafilaturaArgs: () => ["trafilatura", "--", "-m", "trafilatura", "--markdown", "--formatting"],
		label: "pip-run",
	},
];

let detectedRunner: PythonRunner | null = null;
let runnerDetectionDone = false;

async function detectPythonRunner(execFn: ExtensionAPI["exec"]): Promise<PythonRunner | null> {
	if (runnerDetectionDone) return detectedRunner;

	for (const runner of PYTHON_RUNNERS) {
		try {
			const result = await execFn(runner.command, ["--version"], { timeout: 5000 });
			if (result.code === 0) {
				detectedRunner = runner;
				runnerDetectionDone = true;
				return detectedRunner;
			}
		} catch {
			// not available, try next
		}
	}

	runnerDetectionDone = true;
	return null;
}

// --- Content Extraction ---

async function extractContent(
	html: string,
	signal?: AbortSignal,
): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> {
	if (signal?.aborted) return { ok: false, error: "Aborted" };

	if (!detectedRunner) {
		return { ok: false, error: "No Python tool runner found. Install one of: uv (recommended), pipx, or pip-run." };
	}

	const { command, args } = { command: detectedRunner.command, args: detectedRunner.trafilaturaArgs() };

	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		const onAbort = () => killProcess(proc);
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);

			if (signal?.aborted) {
				resolve({ ok: false, error: "Aborted" });
				return;
			}

			if (code !== 0) {
				resolve({ ok: false, error: `Trafilatura extraction failed (exit code ${code}): ${stderr.trim() || "(no error output)"}` });
				return;
			}

			const trimmed = stdout.trim();
			if (!trimmed) {
				resolve({ ok: false, error: "Trafilatura extracted no content from the page. The page may be empty or use a format that trafilatura cannot parse." });
				return;
			}

			resolve({ ok: true, markdown: trimmed });
		});

		proc.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ ok: false, error: `Failed to run ${command} trafilatura: ${err.message}` });
		});

		// Pipe HTML to stdin
		proc.stdin.write(html);
		proc.stdin.end();
	});
}

// --- Batch Result Formatting ---

/**
 * Format batch results into a single text content block with per-page headers.
 * Exported for testing.
 */
export function formatBatchResults(
	pages: Array<{ url: string }>,
	results: PromiseSettledResult<any>[],
) {
	const total = pages.length;

	// Single page: return the result directly without batch header wrapper
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
			if (result.isError) {
				const textContent = result.content?.[0];
				body = `Error: ${textContent?.type === "text" ? textContent.text : "Unknown error"}`;
			} else {
				const textContent = result.content?.[0];
				body = textContent?.type === "text" ? textContent.text : "(no content)";
			}
		}

		sections.push(`${header}\n${body}`);
	}

	return {
		content: [{ type: "text", text: sections.join("\n\n") }],
	};
}


// --- Batch Status Rendering ---

const STATUS_ICONS: Record<BatchPageStatus, string> = {
	pending: "○",
	fetching: "◐",
	extracting: "◑",
	done: "●",
	error: "✗",
};

const STATUS_LABELS: Record<BatchPageStatus, string> = {
	pending: "waiting",
	fetching: "fetching",
	extracting: "extracting",
	done: "done",
	error: "error",
};

function renderBatchStatus(pages: BatchPageState[], theme: any): Container {
	const container = new Container();

	for (const page of pages) {
		const icon = STATUS_ICONS[page.status];
		const label = STATUS_LABELS[page.status];

		// Shorten URL for display
		let displayUrl: string;
		try {
			const parsed = new URL(page.url);
			const path = parsed.pathname + parsed.search;
			displayUrl = parsed.hostname + (path.length > 40 ? path.slice(0, 40) + "..." : path);
		} catch {
			displayUrl = page.url.length > 60 ? page.url.slice(0, 60) + "..." : page.url;
		}

		let line: string;
		if (page.status === "done") {
			line = theme.fg("success", icon) + " " + theme.fg("dim", displayUrl);
		} else if (page.status === "error") {
			line = theme.fg("error", icon) + " " + theme.fg("error", displayUrl) + theme.fg("dim", " · " + label);
		} else if (page.status === "pending") {
			line = theme.fg("muted", icon + " " + displayUrl);
		} else {
			line = theme.fg("accent", icon) + " " + theme.fg("accent", displayUrl) + theme.fg("dim", " · " + label);
		}

		container.addChild(new Text(line, 0, 0));
	}

	return container;
}
// --- Extension ---

export default function (pi: ExtensionAPI) {
	let cleanupInterval: ReturnType<typeof setInterval> | null = null;
	let store: FetchStore | null = null;
	let storeError: string | null = null;

	// Dependency check and extension loading on session start
	pi.on("session_start", async (_event, ctx) => {
		const runner = await detectPythonRunner(pi.exec.bind(pi));
		if (!runner) {
			ctx.ui.notify(
				"web_fetch: no Python tool runner found. Install one of: uv (recommended), pipx, or pip-run",
				"error",
			);
		}

		// 1. Subscribe to event bus registrations (persistent for session lifetime)
		setupEventBusRegistration(pi);

		// 2. Load local extensions
		const localDir = config.extensionsDir ? expandHome(config.extensionsDir) : join(DATA_DIR, "extensions");
		await loadLocalExtensions(localDir, ctx.ui.notify.bind(ctx.ui));

		// 3. Open storage for complete extractions and remove stale session directories
		try {
			store = await FetchStore.open({
				sessionsRoot: SESSIONS_DIR,
				ephemeralRoot: EPHEMERAL_DIR,
				sessionId: ctx.sessionManager.getSessionId(),
				persisted: ctx.sessionManager.getSessionFile() !== undefined,
			});
			storeError = null;
			const retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
			await cleanupSessionDirectories(SESSIONS_DIR, { retentionDays, keep: store.directory });
			await cleanupSessionDirectories(EPHEMERAL_DIR, { retentionDays: EPHEMERAL_RETENTION_DAYS, keep: store.directory });
		} catch (err: any) {
			storeError = `could not prepare storage: ${err?.message || String(err)}`;
			ctx.ui.notify(`web_fetch: ${storeError}`, "warning");
		}

		// 4. Signal readiness to other Pi extensions
		pi.events.emit("web-fetch:ready", undefined);

		// Start cache cleanup interval
		cleanupInterval = setInterval(cleanupCache, CACHE_CLEANUP_INTERVAL_MS);
	});

	// Clean up on shutdown
	pi.on("session_shutdown", async (event) => {
		if (cleanupInterval) {
			clearInterval(cleanupInterval);
			cleanupInterval = null;
		}
		cache.clear();
		await browserPool.shutdown();
		try {
			// `reason` is available in current Pi; older versions omit it, so ephemeral files are removed.
			await store?.close((event as { reason?: string } | undefined)?.reason);
		} catch {
			// Best-effort cleanup; stale ephemeral directories are removed on a later start.
		}
		store = null;
	});

	// Register the web_fetch tool
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: [
			"Retrieves a web page in headless Chrome and extracts its main content as Markdown.",
			"It never summarizes or answers questions about the page; analyze the returned content yourself.",
			"",
			"Batch mode: use 'pages' instead of 'url' to fetch multiple URLs in a single call.",
			"The 'url' and 'pages' parameters are mutually exclusive. Maximum 10 pages per batch.",
			"",
			"Output:",
			"- Each result starts with source metadata: final URL, requested URL and redirects when they differ, and the path of the saved Markdown file.",
			"- The complete extraction is always saved to that file. When it is too large to return inline, the result is a clearly marked PREVIEW ONLY; use read or grep on the saved file for the rest.",
			"",
			"Behavior notes:",
			"- URLs must include the scheme (e.g. https://). Plain HTTP is upgraded to HTTPS.",
			"- Redirects are followed automatically. Redirects from HTTPS to HTTP are rejected.",
			"- Requests to localhost, private networks, link-local/cloud metadata and other special-purpose addresses are blocked. Use bash with curl for local services.",
			"- Extracted content is held in a short-lived cache.",
		].join("\n"),
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Fully-formed URL to fetch (e.g., https://example.com/page). Mutually exclusive with 'pages'." })),
			pages: Type.Optional(
				Type.Array(
					Type.Object({
						url: Type.String({ description: "Fully-formed URL to fetch" }),
					}),
					{ maxItems: MAX_BATCH_SIZE, description: `Array of pages to fetch concurrently (max ${MAX_BATCH_SIZE}). Mutually exclusive with 'url'.` },
				),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			// --- Parameter validation ---
			const hasUrl = params.url !== undefined && params.url !== null;
			const hasPages = params.pages !== undefined && params.pages !== null;

			if (hasUrl && hasPages) {
				return {
					content: [{ type: "text", text: "The 'url' and 'pages' parameters are mutually exclusive. Use 'url' for a single page or 'pages' for batch fetching, not both." }],
					isError: true,
				};
			}

			if (!hasUrl && !hasPages) {
				return {
					content: [{ type: "text", text: "Either 'url' or 'pages' must be provided." }],
					isError: true,
				};
			}

			if (hasPages) {
				const pages = params.pages!;
				if (pages.length === 0) {
					return {
						content: [{ type: "text", text: "The 'pages' array must contain at least one entry." }],
						isError: true,
					};
				}
				if (pages.length > MAX_BATCH_SIZE) {
					return {
						content: [{ type: "text", text: `The 'pages' array exceeds the maximum batch size of ${MAX_BATCH_SIZE}.` }],
						isError: true,
					};
				}

				// --- Batch mode ---
				return await executeBatch(pages, signal, onUpdate);
			}

			// --- Single URL mode — route through batch for unified status view ---
			return await executeBatch([{ url: params.url! }], signal, onUpdate);
		},

		renderCall(args, theme) {
			if (args.pages && Array.isArray(args.pages)) {
				const count = args.pages.length;
				let text = theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", `${count} page${count === 1 ? "" : "s"}`);
				// Show first few URLs
				const urls = args.pages.slice(0, 3).map((p: any) => {
					const u = p.url || "...";
					return u.length > 50 ? u.slice(0, 50) + "..." : u;
				});
				text += "  " + theme.fg("dim", urls.join(", "));
				if (count > 3) text += theme.fg("dim", ` +${count - 3} more`);
				return new Text(text, 0, 0);
			}

			const url = args.url || "...";
			const shortUrl = url.length > 70 ? url.slice(0, 70) + "..." : url;
			let text = theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", shortUrl);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			// Show per-URL status lines while in progress
			const batchDetails = result.details as BatchDetails | undefined;
			if (isPartial && batchDetails?.pages) {
				return renderBatchStatus(batchDetails.pages, theme);
			}

			const isError = (result as { isError?: boolean }).isError;
			const textContent = result.content[0];
			const text = textContent?.type === "text" ? textContent.text : "(no output)";

			if (isError) {
				return new Text("\n" + theme.fg("error", "\u2717 ") + theme.fg("error", text), 0, 0);
			}

			const icon = theme.fg("success", "\u2713 ");
			if (expanded) {
				return new Markdown("\n" + text, 0, 0, getMarkdownTheme());
			}

			// Collapsed: show first few lines
			const lines = text.split("\n");
			const preview = lines.slice(0, 5).join("\n");
			const suffix = lines.length > 5 ? theme.fg("muted", `\n... (${lines.length - 5} more lines, Ctrl+O to expand)`) : "";
			return new Text("\n" + icon + preview + suffix, 0, 0);
		},
	});

	// --- Single URL Pipeline ---

	/**
	 * Process a single URL through the full pipeline: validate → cache → hooks → fetch → extract → process.
	 * Used by both single-URL mode and batch mode (per page).
	 */
	async function processSingleUrl(
		rawUrl: string,
		format: FormatOptions,
		signal?: AbortSignal,
		onUpdate?: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[3],
	) {
		// 1. Validate and normalize URL
		const urlResult = validateAndNormalizeUrl(rawUrl);
		if (urlResult.url === undefined) {
			return {
				content: [{ type: "text", text: urlResult.error }],
				isError: true,
			};
		}
		const url = urlResult.url;

		// Find matching extension (if any)
		const matchedExtension = registry.match(url);
		const hookCtx = createHookContext(url, { signal });

		// 2. Check cache (before hooks, since beforeFetch may short-circuit)
		const cached = getCached(url);
		if (cached) {
			return { content: [{ type: "text", text: formatPageResult(cached, format) }] };
		}

		// 3. beforeFetch hook — can short-circuit entire pipeline
		if (matchedExtension?.beforeFetch) {
			const hookResult = await matchedExtension.beforeFetch(hookCtx);
			if (hookResult) {
				return hookResult;
			}
		}

		// 4. Fetch page
		const fetchOuter = await runFetch(url, signal, onUpdate);
		if (fetchOuter.done) return fetchOuter.result;
		const fetched = fetchOuter.page;
		let html = fetched.html;

		// 5. afterFetch hook — can replace HTML or short-circuit
		if (matchedExtension?.afterFetch) {
			const afterFetchCtx: AfterFetchHookContext = { ...hookCtx, html };
			const hookResult = await matchedExtension.afterFetch(afterFetchCtx);
			if (hookResult) {
				if ("content" in hookResult && Array.isArray(hookResult.content)) {
					// HookResult — short-circuit
					return hookResult as HookResult;
				}
				if ("html" in hookResult && typeof (hookResult as any).html === "string") {
					// HTML replacement
					html = (hookResult as { html: string }).html;
				}
			}
		}

		// 6. Extract content
		const extractOuter = await runExtract(html, signal, onUpdate);
		if (extractOuter.done) return extractOuter.result;
		let markdown = extractOuter.markdown;

		// 7. afterExtract hook — can replace markdown or short-circuit
		if (matchedExtension?.afterExtract) {
			const afterExtractCtx: AfterExtractHookContext = { ...hookCtx, markdown };
			const hookResult = await matchedExtension.afterExtract(afterExtractCtx);
			if (hookResult) {
				if (typeof hookResult === "string") {
					// String replacement
					markdown = hookResult;
				} else if ("content" in hookResult && Array.isArray(hookResult.content)) {
					// HookResult — short-circuit
					return hookResult as HookResult;
				}
			}
		}

		// 8. Save the complete extraction
		const page: ExtractedPage = {
			requestedUrl: fetched.requestedUrl,
			finalUrl: fetched.finalUrl,
			redirectChain: fetched.redirectChain,
			blockedRequests: fetched.blockedRequests,
			markdown,
		};
		if (store) {
			try {
				page.savedPath = await store.save({ ...page, fetchedAt: new Date() });
			} catch (err: any) {
				page.saveError = `could not save extraction: ${err?.message || String(err)}`;
			}
		} else {
			page.saveError = storeError ?? "storage is not available";
		}

		// 9. Cache only successfully saved pages, so cached results always include a valid file path
		if (page.savedPath) setCache(url, page);

		// 10. Return extracted content
		return { content: [{ type: "text", text: formatPageResult(page, format) }] };
	}

	// --- Batch Execution ---

	/**
	 * Execute a batch of pages concurrently. Each page goes through the full
	 * processSingleUrl pipeline independently. Results are collected in order
	 * and formatted into a single text block with per-page headers.
	 */
	async function executeBatch(
		pages: Array<{ url: string }>,
		signal?: AbortSignal,
		onUpdate?: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[3],
	) {
		const format: FormatOptions = pages.length === 1 ? {} : batchBudget(pages.length);

		// Track per-page status for UI
		const pageStates: BatchPageState[] = pages.map((p) => ({
			url: p.url,
			status: "pending" as BatchPageStatus,
		}));

		function emitBatchUpdate() {
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { pages: pageStates } as BatchDetails,
			});
		}

		emitBatchUpdate();

		// Launch all pages concurrently — browser pool handles backpressure
		const promises = pages.map(async (page, i) => {
			// Create a per-page onUpdate that maps stage text to batch page status
			const pageOnUpdate: typeof onUpdate = (partial) => {
				const text = partial.content?.[0];
				if (text?.type === "text") {
					const msg = text.text;
					if (msg.startsWith("Fetching")) {
						pageStates[i].status = "fetching";
					} else if (msg.startsWith("Extracting")) {
						pageStates[i].status = "extracting";
					}
				}
				emitBatchUpdate();
			};

			const result = await processSingleUrl(page.url, format, signal, pageOnUpdate);

			// Mark done or error based on result
			if (result.isError) {
				pageStates[i].status = "error";
				const errText = result.content?.[0];
				if (errText?.type === "text") {
					pageStates[i].error = errText.text;
				}
			} else {
				pageStates[i].status = "done";
			}
			emitBatchUpdate();

			return result;
		});

		const results = await Promise.allSettled(promises);

		// Format results into a single text block
		return formatBatchResults(pages, results);
	}
	// --- Pipeline Stage Functions ---

	/**
	 * Stage: Fetch page via puppeteer.
	 * Returns either a done result (error) or the fetched page to continue processing.
	 */
	async function runFetch(
		url: string,
		signal?: AbortSignal,
		onUpdate?: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[3],
	): Promise<{ done: true; result: any } | { done: false; page: FetchedPage }> {
		onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}...` }], details: undefined });

		const fetchResult = await fetchPage(browserPool, url, { signal, timeoutMs: PAGE_TIMEOUT_MS });
		if (!fetchResult.ok) {
			return {
				done: true,
				result: {
					content: [{ type: "text", text: fetchResult.error }],
					isError: true,
				},
			};
		}

		return { done: false, page: fetchResult.page };
	}

	/**
	 * Stage: Extract content from HTML via trafilatura.
	 * Returns either a done result (error) or the markdown to continue processing.
	 */
	async function runExtract(
		html: string,
		signal?: AbortSignal,
		onUpdate?: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[3],
	): Promise<{ done: true; result: any } | { done: false; markdown: string }> {
		onUpdate?.({ content: [{ type: "text", text: "Extracting content..." }], details: undefined });

		const extractResult = await withTimeout(extractContent(html, signal), EXTRACT_TIMEOUT_MS, "Content extraction", signal).catch((err): { ok: false; error: string } => ({ ok: false, error: err.message }));
		if (!extractResult.ok) {
			return {
				done: true,
				result: {
					content: [{ type: "text", text: (extractResult as { ok: false; error: string }).error }],
					isError: true,
				},
			};
		}

		return { done: false, markdown: extractResult.markdown };
	}
}
