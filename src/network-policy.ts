/**
 * Network policy for browser requests.
 *
 * Every request made by the headless browser — the initial navigation,
 * redirects, client-side navigations and page subresources — is checked
 * against this policy. Requests to local, private, link-local and other
 * special-purpose addresses are blocked, and main-frame navigations must use
 * HTTPS.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export interface ResolvedAddress {
	address: string;
	family: number;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** Schemes that never leave the browser process. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);
/** Network schemes allowed for subresources (subject to address checks). */
const NETWORK_SCHEMES = new Set(["https:", "http:"]);

const blockedIPv4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // "this" network
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, including cloud metadata services
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // deprecated 6to4 relay anycast
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved and broadcast
] as const) {
	blockedIPv4.addSubnet(network, prefix, "ipv4");
}

const globalUnicastIPv6 = new BlockList();
globalUnicastIPv6.addSubnet("2000::", 3, "ipv6");

const blockedGlobalIPv6 = new BlockList();
for (const [network, prefix] of [
	["2001::", 23], // IETF protocol assignments, including Teredo
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4
	["3fff::", 20], // documentation
] as const) {
	blockedGlobalIPv6.addSubnet(network, prefix, "ipv6");
}

/** Remove URL brackets and an IPv6 zone identifier. */
function normalizeAddress(address: string): string {
	return address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
}

/** Expand an IPv6 address into eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
	let text = normalizeAddress(address);
	// Convert an embedded dotted IPv4 suffix into two hexadecimal groups.
	const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		const octets = dotted[1].split(".").map(Number);
		if (octets.some((n) => n > 255)) return null;
		const high = ((octets[0] << 8) | octets[1]).toString(16);
		const low = ((octets[2] << 8) | octets[3]).toString(16);
		text = text.slice(0, -dotted[1].length) + `${high}:${low}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
	return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedIPv4(groups: number[], highIndex: number): string {
	const high = groups[highIndex];
	const low = groups[highIndex + 1];
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Return true for addresses that must not be reachable from web_fetch.
 * Unrecognized addresses are treated as blocked.
 */
export function isBlockedAddress(rawAddress: string): boolean {
	const address = normalizeAddress(rawAddress);
	const family = isIP(address);
	if (family === 4) return blockedIPv4.check(address, "ipv4");
	if (family !== 6) return true;

	const groups = ipv6Groups(address);
	if (!groups) return true;

	// IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
	// addresses are judged by their embedded IPv4 address. :: and ::1 are
	// covered by the IPv4-compatible rule because 0.0.0.0/8 is blocked.
	const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
	if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
		return isBlockedAddress(embeddedIPv4(groups, 6));
	}

	// Well-known NAT64 prefix 64:ff9b::/96 embeds an IPv4 destination.
	if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
		return isBlockedAddress(embeddedIPv4(groups, 6));
	}

	if (!globalUnicastIPv6.check(address, "ipv6")) return true;
	return blockedGlobalIPv6.check(address, "ipv6");
}

/** Resolve all addresses for a hostname using the operating system resolver. */
export const systemResolver: Resolver = async (hostname) => {
	return await dnsLookup(hostname, { all: true, verbatim: true });
};

/**
 * Checks request URLs. Hostname decisions are cached for the lifetime of the
 * instance, so create one per page fetch.
 */
export class NetworkPolicy {
	private readonly hostDecisions = new Map<string, Promise<PolicyDecision>>();

	constructor(private readonly resolver: Resolver = systemResolver) {}

	/**
	 * Decide whether the browser may make a request.
	 * Main-frame navigations must use HTTPS; subresources may use HTTP or
	 * HTTPS. Both must resolve only to public addresses.
	 */
	async check(rawUrl: string, options: { mainFrameNavigation: boolean }): Promise<PolicyDecision> {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return { allowed: false, reason: "invalid URL" };
		}

		if (LOCAL_SCHEMES.has(url.protocol) && !options.mainFrameNavigation) {
			return { allowed: true };
		}
		if (options.mainFrameNavigation && url.protocol !== "https:") {
			return {
				allowed: false,
				reason: url.protocol === "http:" ? "insecure HTTP navigation" : `unsupported ${url.protocol} navigation`,
			};
		}
		if (!NETWORK_SCHEMES.has(url.protocol)) {
			return { allowed: false, reason: `unsupported ${url.protocol} request` };
		}

		return await this.checkHost(url.hostname);
	}

	private checkHost(rawHostname: string): Promise<PolicyDecision> {
		const hostname = normalizeAddress(rawHostname).replace(/\.$/, "");
		let decision = this.hostDecisions.get(hostname);
		if (!decision) {
			decision = this.resolveHost(hostname);
			this.hostDecisions.set(hostname, decision);
		}
		return decision;
	}

	private async resolveHost(hostname: string): Promise<PolicyDecision> {
		if (!hostname) return { allowed: false, reason: "missing hostname" };
		if (hostname === "localhost" || hostname.endsWith(".localhost")) {
			return { allowed: false, reason: `${hostname} is a local hostname` };
		}

		if (isIP(hostname)) {
			return isBlockedAddress(hostname)
				? { allowed: false, reason: `${hostname} is a local or private address` }
				: { allowed: true };
		}

		let addresses: ResolvedAddress[];
		try {
			addresses = await this.resolver(hostname);
		} catch (err: any) {
			return { allowed: false, reason: `could not resolve ${hostname}: ${err?.code || err?.message || String(err)}` };
		}
		if (addresses.length === 0) return { allowed: false, reason: `${hostname} did not resolve` };

		const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
		if (blocked) {
			return { allowed: false, reason: `${hostname} resolves to local or private address ${blocked.address}` };
		}
		return { allowed: true };
	}
}
