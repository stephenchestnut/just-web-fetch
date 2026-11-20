import { describe, expect, it, vi } from "vitest";
import { fetchPage, type PagePool, type RequestPolicy } from "./fetch-page.js";

type Handler = (request: any) => void;

/** Minimal fake Puppeteer page that replays a scripted request sequence on goto(). */
function fakePage(script: Array<{ url: string; navigation?: boolean; childFrame?: boolean }>, finalUrl: string) {
	const mainFrame = {};
	const childFrame = {};
	let handler: Handler | null = null;
	const requests: any[] = [];

	const page = {
		setBypassServiceWorker: vi.fn().mockResolvedValue(undefined),
		evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
		setRequestInterception: vi.fn().mockResolvedValue(undefined),
		on: vi.fn((event: string, fn: Handler) => {
			if (event === "request") handler = fn;
		}),
		mainFrame: () => mainFrame,
		goto: vi.fn(async () => {
			for (const step of script) {
				let handled = false;
				const request = {
					url: () => step.url,
					isNavigationRequest: () => step.navigation ?? false,
					frame: () => (step.childFrame ? childFrame : mainFrame),
					isInterceptResolutionHandled: () => handled,
					continue: vi.fn(async () => {
						handled = true;
					}),
					abort: vi.fn(async () => {
						handled = true;
					}),
				};
				requests.push(request);
				handler?.(request);
				await vi.waitFor(() => expect(handled).toBe(true));
				if (step.navigation && !step.childFrame && request.abort.mock.calls.length > 0) {
					throw new Error("net::ERR_BLOCKED_BY_CLIENT");
				}
			}
		}),
		content: vi.fn().mockResolvedValue("<html><body>ok</body></html>"),
		url: () => finalUrl,
	};
	return { page, requests };
}

function poolFor(page: any): PagePool & { release: ReturnType<typeof vi.fn> } {
	return {
		acquire: vi.fn().mockResolvedValue(page),
		release: vi.fn().mockResolvedValue(undefined),
	};
}

/** Policy blocking any URL containing "private" or plain-HTTP navigations. */
const policy: RequestPolicy = {
	async check(url, { mainFrameNavigation }) {
		if (url.includes("private")) return { allowed: false, reason: "private address" };
		if (mainFrameNavigation && url.startsWith("http:")) return { allowed: false, reason: "insecure HTTP navigation" };
		return { allowed: true };
	},
};

describe("fetchPage", () => {
	it("follows redirects and reports the full chain", async () => {
		const { page } = fakePage(
			[
				{ url: "https://short.example/a", navigation: true },
				{ url: "https://docs.example/final", navigation: true },
				{ url: "https://cdn.example/app.js" },
			],
			"https://docs.example/final",
		);
		const pool = poolFor(page);
		const result = await fetchPage(pool, "https://short.example/a", { policy });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.page.requestedUrl).toBe("https://short.example/a");
		expect(result.page.finalUrl).toBe("https://docs.example/final");
		expect(result.page.redirectChain).toEqual(["https://short.example/a", "https://docs.example/final"]);
		expect(page.setRequestInterception).toHaveBeenCalledWith(true);
		expect(page.setBypassServiceWorker).toHaveBeenCalledWith(true);
		expect(pool.release).toHaveBeenCalledWith(page);
	});

	it("fails when a redirect goes to a private destination", async () => {
		const { page } = fakePage(
			[
				{ url: "https://public.example/", navigation: true },
				{ url: "https://private.example/admin", navigation: true },
			],
			"https://public.example/",
		);
		const result = await fetchPage(poolFor(page), "https://public.example/", { policy });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Blocked navigation to https://private.example/admin: private address");
		expect(result.error).toContain("https://public.example/");
	});

	it("rejects HTTPS-to-HTTP redirects", async () => {
		const { page } = fakePage(
			[
				{ url: "https://secure.example/", navigation: true },
				{ url: "http://insecure.example/", navigation: true },
			],
			"https://secure.example/",
		);
		const result = await fetchPage(poolFor(page), "https://secure.example/", { policy });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("insecure HTTP navigation");
	});

	it("aborts private subresources and reports them without failing the page", async () => {
		const { page, requests } = fakePage(
			[
				{ url: "https://public.example/", navigation: true },
				{ url: "https://private.example/api" },
				{ url: "https://private.example/frame", navigation: true, childFrame: true },
				{ url: "https://cdn.example/app.js" },
			],
			"https://public.example/",
		);
		const result = await fetchPage(poolFor(page), "https://public.example/", { policy });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(requests[1].abort).toHaveBeenCalledWith("blockedbyclient");
		expect(requests[2].abort).toHaveBeenCalledWith("blockedbyclient");
		expect(requests[3].continue).toHaveBeenCalled();
		expect(result.page.blockedRequests.map((r) => r.url)).toEqual([
			"https://private.example/api",
			"https://private.example/frame",
		]);
		expect(result.page.redirectChain).toEqual(["https://public.example/"]);
	});

	it("blocks the initial navigation when it is private", async () => {
		const { page } = fakePage([{ url: "https://private.example/", navigation: true }], "about:blank");
		const pool = poolFor(page);
		const result = await fetchPage(pool, "https://private.example/", { policy });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Blocked navigation to https://private.example/");
		expect(pool.release).toHaveBeenCalledWith(page);
	});

	it("installs a script disabling network APIs that bypass interception", async () => {
		const { page } = fakePage([{ url: "https://public.example/", navigation: true }], "https://public.example/");
		await fetchPage(poolFor(page), "https://public.example/", { policy });
		const script = page.evaluateOnNewDocument.mock.calls[0][0] as string;
		expect(script).toContain("WebSocket");
		expect(script).toContain("RTCPeerConnection");
	});
});
