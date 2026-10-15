import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { renderCodePage, renderEmailPage } from "../../../apps/relay/src/oauth-pages.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORTS = [[390, 844], [1280, 800]] as const;

/** Writes both MCP sign-in pages with sample values and screenshots each at phone and desktop widths. Returns the PNGs. */
export async function shootSignInPages(dir: string): Promise<string[]> {
  if (!existsSync(CHROME)) throw new Error(`blocked: Google Chrome is not installed at ${CHROME}`);
  mkdirSync(dir, { recursive: true });
  const sample = { action: "/api/mcp/oauth/authorize", clientName: "Claude", redirectHost: "claude.ai", params: { response_type: "code", client_id: "client_sample", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://api.localbox.sh/api/mcp" } };
  const pages = { "08-signin-email": renderEmailPage(sample), "08-signin-code": renderCodePage({ ...sample, email: "you@example.com", accountName: "brave-fox-378" }) };
  const shots: string[] = [];
  for (const [name, html] of Object.entries(pages)) {
    const file = join(dir, `${name}.html`); writeFileSync(file, html);
    for (const [width, height] of VIEWPORTS) {
      const png = join(dir, `${name}-${width}.png`);
      // Headless Chrome won't size a window below about 500 px, so the page gets an exact viewport in a frame.
      const frame = join(dir, `${name}-${width}.frame.html`);
      writeFileSync(frame, `<!doctype html><body style="margin:0"><iframe src="${name}.html" style="display:block;border:0;width:${width}px;height:${height}px"></iframe></body>`);
      await promisify(execFile)(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(dir, ".chrome")}`, `--screenshot=${png}`, `--window-size=${width},${height}`, pathToFileURL(frame).href], { timeout: 60_000 });
      shots.push(png);
    }
  }
  return shots;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) console.log((await shootSignInPages(process.argv[2] ?? ".localbox/proof/shots")).join("\n"));
