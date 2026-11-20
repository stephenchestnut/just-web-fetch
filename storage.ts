/**
 * Storage for complete extracted Markdown.
 *
 * Persisted Pi sessions write to a stable directory named after the session ID,
 * so file paths in tool results remain valid after `pi --session <id>`.
 * Ephemeral sessions use a separate directory that is removed when the
 * session ends, but retained across `/reload` within the same run.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const DEFAULT_RETENTION_DAYS = 30;
/** Ephemeral directories older than this are leftovers from crashed runs. */
export const EPHEMERAL_RETENTION_DAYS = 1;

export interface SavedPage {
	requestedUrl: string;
	finalUrl: string;
	redirectChain: string[];
	markdown: string;
	fetchedAt: Date;
}

export interface FetchStoreOptions {
	/** Directory containing one subdirectory per persisted session. */
	sessionsRoot: string;
	/** Directory containing one subdirectory per ephemeral (`--no-session`) session. */
	ephemeralRoot: string;
	/** Pi session ID. */
	sessionId: string;
	/** Whether the Pi session can be resumed after exit. */
	persisted: boolean;
}

/** Convert a session ID into a safe single path segment. */
export function sessionDirectoryName(sessionId: string): string {
	const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "session";
	if (readable === sessionId) return readable;
	const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return `${readable}-${hash}`;
}

/** Build a readable, collision-resistant filename for a saved page. */
export function savedPageFilename(page: Pick<SavedPage, "requestedUrl" | "finalUrl" | "fetchedAt">, nonce = ""): string {
	const timestamp = page.fetchedAt.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	let host = "page";
	try {
		host = new URL(page.finalUrl).hostname.replace(/[^A-Za-z0-9.-]/g, "_").slice(0, 80) || host;
	} catch {
		// Keep the default host label.
	}
	const hash = createHash("sha256")
		.update(`${page.requestedUrl}\n${page.finalUrl}\n${page.fetchedAt.toISOString()}\n${nonce}`)
		.digest("hex")
		.slice(0, 8);
	return `${timestamp}-${host}-${hash}.md`;
}

function frontMatterValue(value: string): string {
	return JSON.stringify(value);
}

/** Render a saved Markdown document with source metadata. */
export function renderSavedPage(page: SavedPage): string {
	const lines = [
		"---",
		`requested_url: ${frontMatterValue(page.requestedUrl)}`,
		`final_url: ${frontMatterValue(page.finalUrl)}`,
		`fetched_at: ${frontMatterValue(page.fetchedAt.toISOString())}`,
	];
	if (page.redirectChain.length > 1) {
		lines.push("redirect_chain:");
		for (const url of page.redirectChain) lines.push(`  - ${frontMatterValue(url)}`);
	}
	lines.push("---", "", page.markdown, "");
	return lines.join("\n");
}

export class FetchStore {
	readonly directory: string;
	readonly persisted: boolean;
	private writes = 0;

	private constructor(directory: string, persisted: boolean) {
		this.directory = directory;
		this.persisted = persisted;
	}

	/** Create the private directory for the current Pi session. */
	static async open(options: FetchStoreOptions): Promise<FetchStore> {
		const root = options.persisted ? options.sessionsRoot : options.ephemeralRoot;
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		const directory = join(root, sessionDirectoryName(options.sessionId));
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const store = new FetchStore(directory, options.persisted);
		await store.touch();
		return store;
	}

	/** Write a complete extraction and return its absolute path. */
	async save(page: SavedPage): Promise<string> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		const filename = savedPageFilename(page, `${process.pid}-${++this.writes}-${Math.random()}`);
		const path = join(this.directory, filename);
		await writeFile(path, renderSavedPage(page), { encoding: "utf-8", mode: 0o600, flag: "wx" });
		await this.touch();
		return path;
	}

	/** Mark this session directory as recently used. */
	async touch(): Promise<void> {
		const now = new Date();
		try {
			await utimes(this.directory, now, now);
		} catch {
			// Cleanup timing is best-effort.
		}
	}

	/**
	 * Called at session shutdown. Persisted session files are always retained.
	 * Ephemeral files are retained across `/reload` (the same run continues)
	 * and removed for every other shutdown reason.
	 */
	async close(reason?: string): Promise<void> {
		if (!this.persisted && reason !== "reload") {
			await rm(this.directory, { recursive: true, force: true });
		}
	}
}

/**
 * Delete session directories not used within the retention period.
 * Returns the number of removed directories.
 */
export async function cleanupSessionDirectories(
	sessionsRoot: string,
	options: { retentionDays: number; keep?: string; now?: Date },
): Promise<number> {
	if (!(options.retentionDays > 0)) return 0;

	let entries;
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true });
	} catch (err: any) {
		if (err?.code === "ENOENT") return 0;
		throw err;
	}

	const root = resolve(sessionsRoot);
	const keep = options.keep ? resolve(options.keep) : undefined;
	const cutoff = (options.now ?? new Date()).getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
	let removed = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const directory = resolve(root, entry.name);
		if (directory === keep || !directory.startsWith(root + sep)) continue;
		try {
			const info = await stat(directory);
			if (info.mtimeMs < cutoff) {
				await rm(directory, { recursive: true, force: true });
				removed++;
			}
		} catch {
			// A concurrent Pi process may have removed or changed it.
		}
	}

	return removed;
}
