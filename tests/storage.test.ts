import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupSessionDirectories,
	FetchStore,
	renderSavedPage,
	savedPageFilename,
	sessionDirectoryName,
} from "../src/storage.js";

let root: string;
let sessionsRoot: string;
let ephemeralRoot: string;

const page = {
	requestedUrl: "https://example.com/start",
	finalUrl: "https://www.example.com/final",
	redirectChain: ["https://example.com/start", "https://www.example.com/final"],
	markdown: "# Title\n\nBody",
	fetchedAt: new Date("2026-11-20T15:04:12.345Z"),
};

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "just-web-fetch-test-"));
	sessionsRoot = join(root, "sessions");
	ephemeralRoot = join(root, "ephemeral");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("naming", () => {
	it("uses safe session IDs unchanged", () => {
		expect(sessionDirectoryName("0199a8f0-1234-7abc")).toBe("0199a8f0-1234-7abc");
	});

	it("sanitizes unsafe session IDs into one path segment", () => {
		const name = sessionDirectoryName("../../evil/id");
		expect(name).not.toContain("/");
		expect(name.startsWith(".")).toBe(false);
		expect(name).toMatch(/-[0-9a-f]{8}$/);
	});

	it("builds readable saved-page filenames", () => {
		expect(savedPageFilename(page)).toMatch(/^2026-11-20T15-04-12Z-www\.example\.com-[0-9a-f]{8}\.md$/);
	});

	it("renders source metadata before the complete Markdown", () => {
		const rendered = renderSavedPage(page);
		expect(rendered).toContain('requested_url: "https://example.com/start"');
		expect(rendered).toContain('final_url: "https://www.example.com/final"');
		expect(rendered).toContain("redirect_chain:");
		expect(rendered.endsWith("# Title\n\nBody\n")).toBe(true);
	});
});

describe("FetchStore", () => {
	it("saves complete Markdown in a private persisted session directory", async () => {
		const store = await FetchStore.open({ sessionsRoot, ephemeralRoot, sessionId: "session-1", persisted: true });
		const path = await store.save(page);

		expect(path.startsWith(join(sessionsRoot, "session-1"))).toBe(true);
		expect(await readFile(path, "utf-8")).toContain("# Title\n\nBody");
		if (process.platform !== "win32") {
			expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
	});

	it("keeps persisted files after shutdown and reopening the same session", async () => {
		const first = await FetchStore.open({ sessionsRoot, ephemeralRoot, sessionId: "resume-me", persisted: true });
		const path = await first.save(page);
		await first.close("quit");

		const resumed = await FetchStore.open({ sessionsRoot, ephemeralRoot, sessionId: "resume-me", persisted: true });
		expect(resumed.directory).toBe(first.directory);
		expect(await readFile(path, "utf-8")).toContain("Body");
	});

	it("uses distinct files for repeated fetches of the same URL", async () => {
		const store = await FetchStore.open({ sessionsRoot, ephemeralRoot, sessionId: "repeat", persisted: true });
		const first = await store.save(page);
		const second = await store.save(page);
		expect(first).not.toBe(second);
		expect(await readdir(store.directory)).toHaveLength(2);
	});

	it("keeps ephemeral files across reload and removes them on quit", async () => {
		const store = await FetchStore.open({ sessionsRoot, ephemeralRoot, sessionId: "no-session", persisted: false });
		expect(store.directory.startsWith(ephemeralRoot)).toBe(true);
		const path = await store.save(page);

		await store.close("reload");
		expect(await readFile(path, "utf-8")).toContain("Body");

		await store.close("quit");
		await expect(stat(store.directory)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("cleanupSessionDirectories", () => {
	const now = new Date("2026-11-20T00:00:00Z");
	const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

	async function makeSession(name: string, lastUsed: Date): Promise<string> {
		const directory = join(sessionsRoot, name);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "page.md"), "content");
		await utimes(directory, lastUsed, lastUsed);
		return directory;
	}

	it("removes directories unused for longer than the retention period", async () => {
		await makeSession("old", daysAgo(31));
		await makeSession("recent", daysAgo(29));

		const removed = await cleanupSessionDirectories(sessionsRoot, { retentionDays: 30, now });

		expect(removed).toBe(1);
		expect((await readdir(sessionsRoot)).sort()).toEqual(["recent"]);
	});

	it("never removes the current session directory", async () => {
		const current = await makeSession("current", daysAgo(90));
		await cleanupSessionDirectories(sessionsRoot, { retentionDays: 30, keep: current, now });
		expect(await readdir(sessionsRoot)).toEqual(["current"]);
	});

	it("ignores files and missing roots", async () => {
		await mkdir(sessionsRoot, { recursive: true });
		await writeFile(join(sessionsRoot, "notes.txt"), "keep");
		await utimes(join(sessionsRoot, "notes.txt"), daysAgo(90), daysAgo(90));

		await expect(cleanupSessionDirectories(sessionsRoot, { retentionDays: 30, now })).resolves.toBe(0);
		await expect(cleanupSessionDirectories(join(root, "missing"), { retentionDays: 30, now })).resolves.toBe(0);
		expect(await readdir(sessionsRoot)).toEqual(["notes.txt"]);
	});

	it("disables cleanup when retentionDays is zero", async () => {
		await makeSession("old", daysAgo(365));
		await expect(cleanupSessionDirectories(sessionsRoot, { retentionDays: 0, now })).resolves.toBe(0);
		expect(await readdir(sessionsRoot)).toEqual(["old"]);
	});
});
