import { describe, expect, it } from "vitest";
import { findBrowserExecutable, systemBrowserCandidates } from "../src/browser-path.js";

const exists = (...paths: string[]) => (path: string) => paths.includes(path);
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("findBrowserExecutable", () => {
	it("prefers PUPPETEER_EXECUTABLE_PATH", () => {
		const result = findBrowserExecutable({
			env: { PUPPETEER_EXECUTABLE_PATH: "/custom/chrome" },
			platform: "darwin",
			home: "/Users/me",
			puppeteerPath: () => "/cache/chrome",
			isExecutable: exists("/custom/chrome", "/cache/chrome", MAC_CHROME),
		});
		expect(result).toEqual({ ok: true, path: "/custom/chrome", source: "environment" });
	});

	it("reports an invalid PUPPETEER_EXECUTABLE_PATH instead of silently ignoring it", () => {
		const result = findBrowserExecutable({
			env: { PUPPETEER_EXECUTABLE_PATH: "/missing/chrome" },
			platform: "darwin",
			home: "/Users/me",
			isExecutable: exists(MAC_CHROME),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("/missing/chrome");
	});

	it("uses Puppeteer's downloaded browser when present", () => {
		const result = findBrowserExecutable({
			env: {},
			platform: "darwin",
			home: "/Users/me",
			puppeteerPath: () => "/cache/chrome",
			isExecutable: exists("/cache/chrome", MAC_CHROME),
		});
		expect(result).toEqual({ ok: true, path: "/cache/chrome", source: "puppeteer" });
	});

	it("falls back to an installed system browser", () => {
		const result = findBrowserExecutable({
			env: {},
			platform: "darwin",
			home: "/Users/me",
			puppeteerPath: () => "/cache/missing",
			isExecutable: exists(MAC_CHROME),
		});
		expect(result).toEqual({ ok: true, path: MAC_CHROME, source: "system" });
	});

	it("tolerates Puppeteer failing to compute its browser path", () => {
		const result = findBrowserExecutable({
			env: {},
			platform: "darwin",
			home: "/Users/me",
			puppeteerPath: () => {
				throw new Error("no cache");
			},
			isExecutable: exists(MAC_CHROME),
		});
		expect(result.ok && result.path).toBe(MAC_CHROME);
	});

	it("finds browsers in the user's Applications folder", () => {
		const userBrave = "/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
		const result = findBrowserExecutable({ env: {}, platform: "darwin", home: "/Users/me", isExecutable: exists(userBrave) });
		expect(result.ok && result.path).toBe(userBrave);
	});

	it("gives actionable guidance when no browser is found", () => {
		const result = findBrowserExecutable({ env: {}, platform: "linux", home: "/home/me", isExecutable: () => false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("PUPPETEER_EXECUTABLE_PATH");
		expect(result.error).toContain("npx puppeteer browsers install chrome");
		expect(result.error).toContain("/usr/bin/google-chrome");
	});
});

describe("systemBrowserCandidates", () => {
	it("prefers Chrome on each platform", () => {
		expect(systemBrowserCandidates("darwin", {}, "/Users/me")[0]).toBe(MAC_CHROME);
		expect(systemBrowserCandidates("linux", {}, "/home/me")[0]).toBe("/usr/bin/google-chrome-stable");
		expect(systemBrowserCandidates("win32", { PROGRAMFILES: "C:\\Program Files" }, "C:\\Users\\me")[0]).toBe(
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		);
	});
});
