/**
 * Browser page loading with redirect tracking and network policy enforcement.
 */
import type { HTTPRequest, Page } from "puppeteer";
import { NetworkPolicy, type PolicyDecision } from "./network-policy.js";

export const PAGE_TIMEOUT_MS = 10_000;

/** Minimal browser pool interface used by fetchPage. */
export interface PagePool {
	acquire(signal?: AbortSignal): Promise<Page>;
	release(page: Page): Promise<void>;
}

export interface BlockedRequest {
	url: string;
	reason: string;
}

export interface FetchedPage {
	html: string;
	requestedUrl: string;
	finalUrl: string;
	/** Main-frame navigation URLs in order, starting with the requested URL. */
	redirectChain: string[];
	/** Subresource requests blocked by the network policy. */
	blockedRequests: BlockedRequest[];
}

export type FetchPageResult = { ok: true; page: FetchedPage } | { ok: false; error: string };

export interface RequestPolicy {
	check(url: string, options: { mainFrameNavigation: boolean }): Promise<PolicyDecision>;
}

export interface FetchPageOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Policy instance for this fetch. Defaults to a new NetworkPolicy. */
	policy?: RequestPolicy;
}

/**
 * Browser APIs whose traffic bypasses Puppeteer request interception.
 * They are disabled before page scripts run.
 */
const DISABLE_UNINTERCEPTED_NETWORK_APIS = `(() => {
	for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"]) {
		try {
			Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
		} catch {}
	}
})();`;

const MAX_REPORTED_BLOCKED_REQUESTS = 20;

function isMainFrameNavigation(page: Page, request: HTTPRequest): boolean {
	return request.isNavigationRequest() && request.frame() === page.mainFrame();
}

function blockedNavigationError(blocked: BlockedRequest, redirectChain: string[]): string {
	let message = `Blocked navigation to ${blocked.url}: ${blocked.reason}.`;
	if (redirectChain.length > 0) {
		message += `\nRedirect chain: ${[...redirectChain, blocked.url].join(" → ")}`;
	}
	return message;
}

/**
 * Load a URL in a pooled browser tab and return its rendered HTML.
 * Redirects are followed automatically. Every request is checked by the policy.
 */
export async function fetchPage(pool: PagePool, url: string, options: FetchPageOptions = {}): Promise<FetchPageResult> {
	const { signal } = options;
	const timeoutMs = options.timeoutMs ?? PAGE_TIMEOUT_MS;
	const policy = options.policy ?? new NetworkPolicy();
	const redirectChain: string[] = [];
	const blockedRequests: BlockedRequest[] = [];
	let blockedRequestCount = 0;
	let blockedNavigation: BlockedRequest | null = null;
	let page: Page | null = null;

	// Check the requested URL before starting a browser, so blocked URLs fail
	// with the policy reason regardless of browser availability.
	const initial = await policy.check(url, { mainFrameNavigation: true }).catch(
		(err: any): PolicyDecision => ({ allowed: false, reason: `policy check failed: ${err?.message || String(err)}` }),
	);
	if (!initial.allowed) {
		return { ok: false, error: blockedNavigationError({ url, reason: initial.reason }, []) };
	}

	try {
		if (signal?.aborted) return { ok: false, error: "Aborted" };
		page = await pool.acquire(signal);
		const currentPage = page;

		await currentPage.setBypassServiceWorker(true);
		await currentPage.evaluateOnNewDocument(DISABLE_UNINTERCEPTED_NETWORK_APIS);
		await currentPage.setRequestInterception(true);

		currentPage.on("request", (request) => {
			void (async () => {
				if (request.isInterceptResolutionHandled()) return;
				const requestUrl = request.url();
				const mainFrameNavigation = isMainFrameNavigation(currentPage, request);
				let decision: PolicyDecision;
				try {
					decision = await policy.check(requestUrl, { mainFrameNavigation });
				} catch (err: any) {
					decision = { allowed: false, reason: `policy check failed: ${err?.message || String(err)}` };
				}

				if (mainFrameNavigation) {
					if (decision.allowed) {
						if (redirectChain[redirectChain.length - 1] !== requestUrl) redirectChain.push(requestUrl);
					} else {
						blockedNavigation ??= { url: requestUrl, reason: decision.reason };
					}
				} else if (!decision.allowed) {
					blockedRequestCount++;
					if (blockedRequests.length < MAX_REPORTED_BLOCKED_REQUESTS) {
						blockedRequests.push({ url: requestUrl, reason: decision.reason });
					}
				}

				try {
					if (request.isInterceptResolutionHandled()) return;
					if (decision.allowed) await request.continue();
					else await request.abort("blockedbyclient");
				} catch {
					// The page or request may have closed while the policy was checked.
				}
			})();
		});

		try {
			await currentPage.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
		} catch (err: any) {
			if (signal?.aborted) return { ok: false, error: "Aborted" };
			if (blockedNavigation) return { ok: false, error: blockedNavigationError(blockedNavigation, redirectChain) };
			if (err?.name === "TimeoutError" || err?.message?.includes("timeout")) {
				return { ok: false, error: `Page load timed out after ${timeoutMs / 1000} seconds for URL: ${url}` };
			}
			return { ok: false, error: `Failed to load page: ${err?.message || String(err)}` };
		}

		if (blockedNavigation) return { ok: false, error: blockedNavigationError(blockedNavigation, redirectChain) };

		const html = await currentPage.content();
		const finalUrl = currentPage.url();
		if (redirectChain.length === 0) redirectChain.push(url);
		if (redirectChain[redirectChain.length - 1] !== finalUrl) redirectChain.push(finalUrl);

		if (blockedRequestCount > blockedRequests.length) {
			blockedRequests.push({
				url: "(additional requests)",
				reason: `${blockedRequestCount - blockedRequests.length} more blocked requests not listed`,
			});
		}

		return {
			ok: true,
			page: { html, requestedUrl: url, finalUrl, redirectChain, blockedRequests },
		};
	} catch (err: any) {
		if (signal?.aborted) return { ok: false, error: "Aborted" };
		return { ok: false, error: `Browser error: ${err?.message || String(err)}` };
	} finally {
		if (page) await pool.release(page);
	}
}
