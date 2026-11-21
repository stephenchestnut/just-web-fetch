import { describe, it, expect, vi } from "vitest";
import { isBlockedAddress, NetworkPolicy, type Resolver } from "../src/network-policy.js";

const publicResolver: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];

describe("isBlockedAddress", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"198.18.0.1",
		"::",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"fe80::1%en0",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:192.168.1.1",
		"64:ff9b::a9fe:a9fe",
		"2001:db8::1",
		"2002:c0a8:101::1",
		"not-an-ip",
	])("blocks %s", (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it.each(["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
		"allows public address %s",
		(address) => {
			expect(isBlockedAddress(address)).toBe(false);
		},
	);
});

describe("NetworkPolicy", () => {
	it("allows HTTPS navigation to hosts with public addresses", async () => {
		const policy = new NetworkPolicy(publicResolver);
		await expect(policy.check("https://example.com/", { mainFrameNavigation: true })).resolves.toEqual({ allowed: true });
	});

	it("rejects HTTP main-frame navigation, including HTTPS-to-HTTP redirects", async () => {
		const policy = new NetworkPolicy(publicResolver);
		const decision = await policy.check("http://example.com/", { mainFrameNavigation: true });
		expect(decision).toEqual({ allowed: false, reason: "insecure HTTP navigation" });
	});

	it("allows public HTTP subresources", async () => {
		const policy = new NetworkPolicy(publicResolver);
		await expect(policy.check("http://cdn.example.com/a.js", { mainFrameNavigation: false })).resolves.toEqual({ allowed: true });
	});

	it("allows data and blob subresources without DNS", async () => {
		const resolver = vi.fn(publicResolver);
		const policy = new NetworkPolicy(resolver);
		await expect(policy.check("data:image/png;base64,AAAA", { mainFrameNavigation: false })).resolves.toEqual({ allowed: true });
		await expect(policy.check("blob:https://example.com/id", { mainFrameNavigation: false })).resolves.toEqual({ allowed: true });
		expect(resolver).not.toHaveBeenCalled();
	});

	it("rejects non-network main-frame navigations", async () => {
		const policy = new NetworkPolicy(publicResolver);
		const decision = await policy.check("data:text/html,hello", { mainFrameNavigation: true });
		expect(decision.allowed).toBe(false);
	});

	it.each(["ws://example.com/", "file:///etc/passwd", "ftp://example.com/"])("rejects unsupported subresource %s", async (url) => {
		const policy = new NetworkPolicy(publicResolver);
		const decision = await policy.check(url, { mainFrameNavigation: false });
		expect(decision.allowed).toBe(false);
	});

	it.each([
		"https://localhost/",
		"https://app.localhost/",
		"https://127.0.0.1/",
		"https://[::1]/",
		"https://169.254.169.254/latest/meta-data/",
		"https://192.168.1.1/",
	])("blocks local destination %s", async (url) => {
		const resolver = vi.fn(publicResolver);
		const policy = new NetworkPolicy(resolver);
		const decision = await policy.check(url, { mainFrameNavigation: true });
		expect(decision.allowed).toBe(false);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("blocks a hostname if any resolved address is private", async () => {
		const policy = new NetworkPolicy(async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.5", family: 4 },
		]);
		const decision = await policy.check("https://mixed.example/", { mainFrameNavigation: true });
		expect(decision).toEqual({ allowed: false, reason: "mixed.example resolves to local or private address 10.0.0.5" });
	});

	it("blocks hostnames that fail to resolve", async () => {
		const policy = new NetworkPolicy(async () => {
			throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
		});
		const decision = await policy.check("https://missing.example/", { mainFrameNavigation: true });
		expect(decision).toEqual({ allowed: false, reason: "could not resolve missing.example: ENOTFOUND" });
	});

	it("caches hostname decisions within one policy", async () => {
		const resolver = vi.fn(publicResolver);
		const policy = new NetworkPolicy(resolver);
		await policy.check("https://example.com/a", { mainFrameNavigation: true });
		await policy.check("https://example.com/b", { mainFrameNavigation: false });
		expect(resolver).toHaveBeenCalledTimes(1);
	});
});
