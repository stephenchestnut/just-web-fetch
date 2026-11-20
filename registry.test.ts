import { describe, it, expect, beforeEach } from "vitest";
import { matchExtension, ExtensionRegistry } from "./registry.js";
import type { WebFetchExtension } from "./types.js";

// --- Test helpers ---

function makeExt(name: string, matches: string[]): WebFetchExtension {
	return { name, matches };
}

// --- matchExtension ---

describe("matchExtension", () => {
	it("returns null for empty extension list", () => {
		expect(matchExtension("https://example.com/page", [])).toBeNull();
	});

	it("returns null for invalid URL", () => {
		expect(matchExtension("not-a-url", [makeExt("a", ["**"])])).toBeNull();
	});

	it("matches exact domain with wildcard path", () => {
		const ext = makeExt("test", ["example.com/**"]);
		expect(matchExtension("https://example.com/page", [ext])).toBe(ext);
	});

	it("does not match different domain", () => {
		const ext = makeExt("test", ["example.com/**"]);
		expect(matchExtension("https://other.com/page", [ext])).toBeNull();
	});

	it("matches with single-segment wildcard", () => {
		const ext = makeExt("test", ["github.com/*/*/blob/**"]);
		expect(matchExtension("https://github.com/org/repo/blob/main/file.ts", [ext])).toBe(ext);
	});

	it("single-segment wildcard does not match multiple segments", () => {
		const ext = makeExt("test", ["github.com/*/blob/**"]);
		// github.com/org/repo/blob/... has two segments before blob, pattern expects one
		expect(matchExtension("https://github.com/org/repo/blob/main/file.ts", [ext])).toBeNull();
	});

	it("matches with multi-segment wildcard", () => {
		const ext = makeExt("test", ["docs.google.com/**"]);
		expect(matchExtension("https://docs.google.com/document/d/abc123/edit", [ext])).toBe(ext);
	});

	it("returns first matching extension", () => {
		const ext1 = makeExt("first", ["example.com/**"]);
		const ext2 = makeExt("second", ["example.com/**"]);
		expect(matchExtension("https://example.com/page", [ext1, ext2])).toBe(ext1);
	});

	it("tries all patterns in an extension", () => {
		const ext = makeExt("test", ["github.com/*/*/blob/**", "github.com/*/*/tree/**"]);
		expect(matchExtension("https://github.com/org/repo/tree/main/src", [ext])).toBe(ext);
	});

	it("ignores query string and fragment", () => {
		const ext = makeExt("test", ["example.com/page"]);
		expect(matchExtension("https://example.com/page?q=test#section", [ext])).toBe(ext);
	});

	it("strips protocol — matches hostname+pathname only", () => {
		const ext = makeExt("test", ["example.com/page"]);
		// http gets normalized to https by the URL parser but pattern is on host+path
		expect(matchExtension("https://example.com/page", [ext])).toBe(ext);
	});
});

// --- ExtensionRegistry ---

describe("ExtensionRegistry", () => {
	let registry: ExtensionRegistry;

	beforeEach(() => {
		registry = new ExtensionRegistry();
	});

	describe("count and counts", () => {
		it("starts empty", () => {
			expect(registry.count).toBe(0);
			expect(registry.counts).toEqual({ eventBus: 0, local: 0 });
		});

		it("tracks counts per source", () => {
			registry.addLocal(makeExt("l1", ["c.com/**"]));
			registry.addLocal(makeExt("l2", ["b.com/**"]));
			registry.addEventBus(makeExt("e1", ["d.com/**"]));

			expect(registry.count).toBe(3);
			expect(registry.counts).toEqual({ eventBus: 1, local: 2 });
		});
	});

	describe("match", () => {
		it("returns null when no extensions registered", () => {
			expect(registry.match("https://example.com/page")).toBeNull();
		});

		it("matches local extension", () => {
			const ext = makeExt("local", ["example.com/**"]);
			registry.addLocal(ext);
			expect(registry.match("https://example.com/page")).toBe(ext);
		});

		it("matches event-bus extension", () => {
			const ext = makeExt("eventbus", ["example.com/**"]);
			registry.addEventBus(ext);
			expect(registry.match("https://example.com/page")).toBe(ext);
		});

		it("returns null when no extension matches", () => {
			registry.addLocal(makeExt("local", ["other.com/**"]));
			expect(registry.match("https://example.com/page")).toBeNull();
		});
	});

	describe("priority order", () => {
		it("event-bus takes priority over local", () => {
			const eventBusExt = makeExt("eventbus", ["example.com/**"]);
			const localExt = makeExt("local", ["example.com/**"]);

			registry.addLocal(localExt);
			registry.addEventBus(eventBusExt);

			expect(registry.match("https://example.com/page")).toBe(eventBusExt);
		});

		it("falls through to lower priority when higher doesn't match", () => {
			const eventBusExt = makeExt("eventbus", ["other.com/**"]);
			const localExt = makeExt("local", ["example.com/**"]);

			registry.addEventBus(eventBusExt);
			registry.addLocal(localExt);

			expect(registry.match("https://example.com/page")).toBe(localExt);
		});
	});

	describe("registration order within same source", () => {
		it("first registered wins within local", () => {
			const ext1 = makeExt("first", ["example.com/**"]);
			const ext2 = makeExt("second", ["example.com/**"]);

			registry.addLocal(ext1);
			registry.addLocal(ext2);

			expect(registry.match("https://example.com/page")).toBe(ext1);
		});

		it("first registered wins within event-bus", () => {
			const ext1 = makeExt("first", ["example.com/**"]);
			const ext2 = makeExt("second", ["example.com/**"]);

			registry.addEventBus(ext1);
			registry.addEventBus(ext2);

			expect(registry.match("https://example.com/page")).toBe(ext1);
		});
	});
});
