/**
 * Locate a Chrome-compatible browser for Puppeteer.
 *
 * Search order:
 *   1. PUPPETEER_EXECUTABLE_PATH, if set (an invalid value is an error, not skipped)
 *   2. Puppeteer's downloaded browser, if present
 *   3. Standard Chrome, Chromium, Edge and Brave install locations
 *
 * This avoids depending on Puppeteer's postinstall download, which npm may block.
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BrowserSearchOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	/** Path where Puppeteer expects its downloaded browser, if known. */
	puppeteerPath?: () => string | undefined;
	/** Whether a path is an executable file. */
	isExecutable?: (path: string) => boolean;
}

export type BrowserSearchResult =
	| { ok: true; path: string; source: "environment" | "puppeteer" | "system" }
	| { ok: false; error: string };

function defaultIsExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Standard install locations for Chrome-compatible browsers, in preference order. */
export function systemBrowserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
	if (platform === "darwin") {
		const apps = [
			"Google Chrome.app/Contents/MacOS/Google Chrome",
			"Chromium.app/Contents/MacOS/Chromium",
			"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"Brave Browser.app/Contents/MacOS/Brave Browser",
		];
		return [...apps.map((app) => join("/Applications", app)), ...apps.map((app) => join(home, "Applications", app))];
	}

	if (platform === "win32") {
		const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((root): root is string => !!root);
		const relative = [
			"Google\\Chrome\\Application\\chrome.exe",
			"Chromium\\Application\\chrome.exe",
			"Microsoft\\Edge\\Application\\msedge.exe",
			"BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		];
		return relative.flatMap((path) => roots.map((root) => `${root}\\${path}`));
	}

	return [
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
		"/usr/bin/microsoft-edge",
		"/usr/bin/microsoft-edge-stable",
		"/usr/bin/brave-browser",
	];
}

/** Find the browser executable Puppeteer should launch. */
export function findBrowserExecutable(options: BrowserSearchOptions = {}): BrowserSearchResult {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const isExecutable = options.isExecutable ?? defaultIsExecutable;

	const configured = env.PUPPETEER_EXECUTABLE_PATH?.trim();
	if (configured) {
		return isExecutable(configured)
			? { ok: true, path: configured, source: "environment" }
			: { ok: false, error: `PUPPETEER_EXECUTABLE_PATH is set to "${configured}", which is not an executable file.` };
	}

	let bundled: string | undefined;
	try {
		bundled = options.puppeteerPath?.();
	} catch {
		// Puppeteer could not compute its browser path.
	}
	if (bundled && isExecutable(bundled)) return { ok: true, path: bundled, source: "puppeteer" };

	const candidates = systemBrowserCandidates(platform, env, home);
	const found = candidates.find((path) => isExecutable(path));
	if (found) return { ok: true, path: found, source: "system" };

	return {
		ok: false,
		error: [
			"No Chrome-compatible browser found. Do one of the following:",
			"- Install Google Chrome, Chromium, Microsoft Edge, or Brave in a standard location.",
			"- Set PUPPETEER_EXECUTABLE_PATH to a Chrome-compatible browser executable.",
			"- Download Puppeteer's browser: run `npx puppeteer browsers install chrome` in the just-web-fetch directory.",
			`Searched: ${[bundled, ...candidates].filter(Boolean).join(", ")}`,
		].join("\n"),
	};
}
