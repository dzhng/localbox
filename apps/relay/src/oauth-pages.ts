// Server-rendered MCP sign-in pages: no script, the site's palette inline, readable from 390 px up.

export interface PageClient { clientName: string; redirectHost: string }
/** The OAuth request, carried through both steps in hidden fields and re-validated on every post. */
export type AuthorizeParams = Record<string, string>;
export interface EmailPageInput extends PageClient { action: string; params: AuthorizeParams; email?: string; error?: string }
/** `accountName` null: the email has no account yet. Undefined: not known (for example a rate-limited send). */
export interface CodePageInput extends PageClient { action: string; params: AuthorizeParams; email: string; accountName?: string | null; error?: string }

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const hidden = (params: AuthorizeParams) => Object.entries(params).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("");

const style = `
:root { --paper: #ffffff; --paper-soft: #f6f5f2; --ink: #141414; --muted: #5e5a54; --line: #e6e3dd; --orange: #f26b1d; --red: #e5372b;
  --display: "Bricolage Grotesque", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace; --radius: 16px; color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 24px 16px;
  color: var(--ink); background: var(--paper-soft); font: 17px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 420px; background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); padding: 28px 24px; }
.brand { display: flex; align-items: center; gap: 10px; font: 700 18px/1 var(--display); letter-spacing: -0.01em; }
.brand::before { content: ""; width: 14px; height: 14px; border-radius: 4px; background: var(--orange); }
h1 { margin: 22px 0 12px; font: 700 28px/1.15 var(--display); letter-spacing: -0.02em; }
p { margin: 0 0 16px; }
.muted { color: var(--muted); font-size: 15px; }
.grant { margin: 0 0 20px; padding: 14px 16px; border: 1px solid var(--line); border-left: 4px solid var(--orange); border-radius: 10px; background: var(--paper-soft); font-size: 16px; }
.grant strong { overflow-wrap: anywhere; }
.grant .account { white-space: nowrap; }
code { font: 600 0.92em var(--mono); overflow-wrap: anywhere; }
label { display: block; margin: 0 0 6px; font-weight: 600; font-size: 15px; }
input[type=email], input[type=text] { width: 100%; padding: 12px 14px; font: inherit; color: var(--ink); background: var(--paper); border: 1px solid #a9a39a; border-radius: 10px; }
input[name=code] { font: 600 24px/1.2 var(--mono); letter-spacing: 0.3em; text-align: center; }
input::placeholder { color: #b9b3aa; }
input:focus { outline: 3px solid rgba(242, 107, 29, 0.35); outline-offset: 1px; border-color: var(--orange); }
button { width: 100%; margin-top: 16px; padding: 13px 16px; font: 700 17px/1 var(--display); color: #fff; background: var(--ink); border: 0; border-radius: 999px; cursor: pointer; }
button:hover { background: #000; }
button:focus-visible { outline: 3px solid var(--orange); outline-offset: 2px; }
.error { margin: 0 0 16px; padding: 10px 14px; border-radius: 10px; color: var(--red); background: #fdeceb; font-size: 15px; font-weight: 600; }
.foot { margin: 20px 0 0; }
.foot a { white-space: nowrap; }
a { color: var(--ink); }
footer { max-width: 420px; text-align: center; color: var(--muted); font-size: 13px; }
@media (min-width: 720px) { main { padding: 36px 36px 32px; } }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${style}</style></head><body><main><div class="brand">Localbox</div>${body}</main><footer>Localbox runs sandboxes on your own Macs.</footer></body></html>`;
}
const errorLine = (error?: string) => error ? `<p class="error" role="alert">${escape(error)}</p>` : "";
const who = (input: PageClient) => `<strong>${escape(input.clientName)}</strong> (<code>${escape(input.redirectHost)}</code>)`;

export function renderEmailPage(input: EmailPageInput): string {
  return page("Sign in to Localbox", `<h1>Sign in to Localbox</h1>
<p>${who(input)} wants to use your Localbox account. Enter your email and we'll send you a 6-digit code.</p>
${errorLine(input.error)}<form method="post" action="${escape(input.action)}">${hidden(input.params)}<input type="hidden" name="step" value="email">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required autofocus value="${escape(input.email ?? "")}">
<button type="submit">Send code</button></form>`);
}

export function renderCodePage(input: CodePageInput): string {
  const target = input.accountName ? `account <strong class="account">${escape(input.accountName)}</strong>` : input.accountName === null ? "<strong>your new account</strong>" : "<strong>your account</strong>";
  const restart = `${input.action}?${new URLSearchParams(input.params).toString()}`;
  return page("Enter your code · Localbox", `<h1>Enter your code</h1>
<p class="muted">We sent a 6-digit code to <strong>${escape(input.email)}</strong>. It expires in 10 minutes.</p>
<p class="grant">Signing in gives ${who(input)} full access to ${target}: it can create, use and delete sandboxes on all your machines.</p>
${errorLine(input.error)}<form method="post" action="${escape(input.action)}">${hidden(input.params)}<input type="hidden" name="step" value="code"><input type="hidden" name="email" value="${escape(input.email)}">
<label for="code">Code</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required autofocus>
<button type="submit">Sign in</button></form>
<p class="muted foot">Didn't start this from ${escape(input.clientName)}? Close this page; nothing is shared until you sign in.</p>
<p class="muted"><a href="${escape(restart)}">Use a different email</a></p>`);
}

export function renderErrorPage(message: string): string {
  return page("Sign-in problem · Localbox", `<h1>This sign-in link doesn't work</h1>${errorLine(message)}<p class="muted">Go back to the app that sent you here and connect again.</p>`);
}
