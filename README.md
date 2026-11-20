# just-web-fetch

> A fork of [`georgebashi/pi-web-fetch`](https://github.com/georgebashi/pi-web-fetch) by George Bashi.

A [pi](https://github.com/badlogic/pi-mono) extension that fetches web pages in headless Chrome and extracts their main content as Markdown with [trafilatura](https://trafilatura.readthedocs.io/).

It does **just** that: no LLM summarization, no question answering, and no site-specific redirects. The agent receives source text and decides what to do with it.

## Differences from pi-web-fetch

| | pi-web-fetch | just-web-fetch |
|---|---|---|
| **LLM processing** | Optional prompt; pages over ~50KB summarized automatically | None |
| **Large pages** | Summary | Clearly marked preview; complete Markdown saved to a file |
| **Saved content** | In-memory cache only | Per-session Markdown files that survive `pi --session <id>` |
| **Redirects** | Cross-host redirects stop and ask for a second call | Followed and reported; HTTPS → HTTP rejected |
| **Local/private addresses** | Not blocked | Blocked for every browser request |
| **GitHub / Google Docs** | Redirected to `gh` / Workspace tools | Fetched like any other page |

## Features

- **`web_fetch` tool** — fetch one URL or up to 10 concurrently
- **Headless Chrome** via Puppeteer — handles JavaScript-rendered pages
- **Content extraction** — trafilatura removes navigation and boilerplate and outputs Markdown
- **Complete content preserved** — every extraction is saved; large pages return a preview plus the file path
- **Browser pool** — one Chrome instance with up to 6 parallel tabs
- **15-minute cache** — repeated fetches return the same saved result without reloading the page
- **Safe redirects** — redirects are followed and the full chain is reported
- **Private-network guard** — blocks localhost, private networks, link-local and cloud metadata addresses, and other special-purpose ranges
- **Extension hooks** — customize fetching for specific sites

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) coding agent
- A Python tool runner for trafilatura (auto-detected in priority order):
  1. [uv](https://docs.astral.sh/uv/) (`uvx`) — fastest, recommended
  2. `uv run` — fallback if the `uvx` alias is missing
  3. [pipx](https://pipx.pypa.io/)
  4. [pip-run](https://github.com/jaraco/pip-run)
- Node.js 18+

## Installation

Install from Git:

```bash
pi install git:github.com/stephenchestnut/just-web-fetch@main
```

> **Important:** this package registers the same `web_fetch` tool name as `pi-web-fetch`. Install only one of them.

For development:

```bash
git clone https://github.com/stephenchestnut/just-web-fetch
cd just-web-fetch
npm install
pi -e .
```

> **Note:** `npm install` downloads Puppeteer's bundled Chromium (~300MB). To use an existing Chrome or Chromium instead, set `PUPPETEER_SKIP_DOWNLOAD=1` during installation and `PUPPETEER_EXECUTABLE_PATH` when running Pi.

> **Note:** The first time `web_fetch` runs, `uvx` downloads the trafilatura package (~10MB). Subsequent runs use the cached environment.

## Usage

The extension registers a `web_fetch` tool. The agent uses it when it needs web content.

> Fetch https://docs.example.com/api

> Read these pages and compare their approaches to error handling:
> - https://docs.python.org/3/tutorial/errors.html
> - https://go.dev/blog/error-handling-and-go

Batch requests use the `pages` parameter (up to 10 URLs). The UI shows per-URL progress:

```
● docs.python.org/3/tutorial/errors.html
◐ go.dev/blog/error-handling-and-go · fetching
◑ doc.rust-lang.org/book/ch09-00-error-... · extracting
```

Each URL independently moves through pending → fetching → extracting → done/error.

### Results

Each result starts with source metadata:

```
Source: https://docs.python.org/3/builtins/stdtypes.html
Requested: https://docs.python.org/3/library/stdtypes.html
Redirects: https://docs.python.org/3/library/stdtypes.html → https://docs.python.org/3/builtins/stdtypes.html
Saved: ~/.pi/agent/just-web-fetch/sessions/<session-id>/2026-11-20T06-33-13Z-docs.python.org-35b1682b.md (180.7KB, 3571 lines)
Content: PREVIEW ONLY — first 96 of 3571 lines (4.0KB of 180.7KB). Complete extraction saved to: ...
```

- **Small pages** are returned in full (`Content: complete`).
- **Large pages** return a clearly marked preview. The complete Markdown is in the saved file; use `read` or `grep` on it.
- In batch mode, the inline output limit is shared across pages, and every page has its own saved file.
- Blocked subresource requests, if any, are listed.

### Saved files

Complete extractions are stored in private directories (`0700`; files `0600`):

```
<agent-dir>/just-web-fetch/sessions/<session-id>/<timestamp>-<host>-<hash>.md
```

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set. Each file starts with YAML front matter recording the requested URL, final URL, fetch time, and redirect chain.

| Situation | Behavior |
|---|---|
| Quit, then `pi --session <id>` | Files are kept, so paths in the session history still work |
| `/new`, `/resume`, `/reload` | Files are kept |
| Forked session | New fetches use the new session's directory; the parent's files remain |
| `--no-session` | Files go to `<agent-dir>/just-web-fetch/ephemeral/` and are removed when the run ends |
| Session deleted in Pi | Removed later by age-based cleanup |

On startup, session directories unused for `retentionDays` (default 30) are deleted. Leftover ephemeral directories older than one day are also removed.

### Network policy

- URLs must include a scheme. Plain `http://` is upgraded to `https://`; other schemes are rejected.
- Redirects are followed automatically, including to other hosts. HTTP redirects, JavaScript navigation, and meta refreshes are all reported.
- Main-frame navigation must use HTTPS, so HTTPS → HTTP redirects are rejected.
- Every browser request — the page, redirects, frames, scripts, images, and `fetch`/XHR — is checked before it is sent. Hostnames are resolved, and a request is blocked if **any** resolved address is:
  - localhost or loopback (`127.0.0.0/8`, `::1`, `*.localhost`)
  - private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`)
  - link-local, including cloud metadata (`169.254.0.0/16`, `fe80::/10`)
  - carrier-grade NAT, multicast, documentation, benchmarking, reserved, or other special-purpose ranges
  - an IPv4-mapped, IPv4-compatible, or NAT64 IPv6 form of any of these
- Blocked page navigations fail the fetch. Blocked subresources are aborted and listed in the result.
- WebSocket, WebTransport, and WebRTC are disabled because Puppeteer cannot intercept them. Service workers are bypassed.
- There is no allowlist. Use `bash` with `curl` for local services.

**Limitation:** the address check and Chrome's own connection perform separate DNS lookups. A hostile DNS server could return a public address to the check and a private one to Chrome (DNS rebinding). Closing that gap fully requires a filtering proxy or OS-level network controls.

The headless browser uses a fresh profile, so it does not have your normal Chrome cookies or logins.

## Extensions

Extensions customize fetching for specific URLs. Hooks can short-circuit the pipeline before fetching, replace or short-circuit after fetching (HTML), or replace or short-circuit after extraction (Markdown).

### Writing extensions

Extensions are TypeScript or JavaScript modules with a factory function default export:

```typescript
import type { WebFetchExtension } from "just-web-fetch/types";

export default function (): WebFetchExtension {
  return {
    name: "my-handler",
    matches: ["example.com/**"],
    async beforeFetch(ctx) {
      // Return a HookResult to short-circuit, or void to continue
      return { content: [{ type: "text", text: "Use a different tool for this site." }] };
    },
    async afterFetch(ctx) {
      // ctx.html — return { html } to replace it, a HookResult to short-circuit, or void
    },
    async afterExtract(ctx) {
      // ctx.markdown — return a string to replace it, a HookResult to short-circuit, or void
    },
  };
}
```

Results from a short-circuiting hook are returned as-is; they are not saved or cached.

### Extension sources (in priority order)

1. **Event bus** — other pi extensions can register handlers with `pi.events.emit("web-fetch:register", extension)`
2. **Local** — `.ts`/`.js` files in `<agent-dir>/just-web-fetch/extensions/` (or the configured `extensionsDir`)

No extensions are built in.

## Configuration

Optionally create `<agent-dir>/just-web-fetch.json`:

```json
{
  "extensionsDir": "~/my-web-fetch-extensions",
  "retentionDays": 30
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `extensionsDir` | `<agent-dir>/just-web-fetch/extensions/` | Directory for local extensions |
| `retentionDays` | `30` | Delete saved session directories unused for this many days; `0` disables cleanup |

## Architecture

```
web_fetch(url | pages)
  │
  ├─ URL validation & normalization (http→https, scheme check)
  ├─ Cache check (15-min TTL) → same result and saved file
  ├─ Extension: beforeFetch hook
  ├─ Browser pool → Puppeteer page (networkidle2, 10s timeout)
  │    └─ Every request checked by the network policy; redirects followed and recorded
  ├─ Extension: afterFetch hook
  ├─ trafilatura extraction (HTML → Markdown)
  ├─ Extension: afterExtract hook
  ├─ Save complete Markdown to the session directory
  ├─ Cache store
  └─ Result: metadata + complete content, or a marked preview
```

In batch mode, each URL runs through this pipeline independently with its own browser tab.

## Development

```bash
npm install
npm test
```

## License

MIT. Original work copyright (c) 2026 George Bashi; see [LICENSE](LICENSE).
