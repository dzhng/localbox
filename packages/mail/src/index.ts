export interface CodeMessage { to: string; code: string; idempotencyKey: string }
export interface Mailer { sendCode(message: CodeMessage): Promise<void> }

export class ResendMailer implements Mailer {
  constructor(private readonly apiKey = process.env.RESEND_API_KEY, private readonly fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new Error("RESEND_API_KEY is required");
  }
  async sendCode(message: CodeMessage): Promise<void> {
    const response = await this.fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "Idempotency-Key": message.idempotencyKey }, body: JSON.stringify({ from: "Localbox <login@mail.localbox.sh>", to: [message.to], subject: "Your Localbox sign-in code", text: `Your Localbox sign-in code is ${message.code}. It expires in 10 minutes.` }) });
    if (!response.ok) throw new Error(`Resend rejected email (${response.status})`);
  }
}
export class DevLogMailer implements Mailer {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    if (process.env.LOCALBOX_LOCAL_SERVICES !== "1" || process.env.LOCALBOX_DEV_PRINT_CODES !== "1") throw new Error("dev mailer requires local services and code printing");
  }
  async sendCode(message: CodeMessage): Promise<void> { this.write(JSON.stringify({ event: "localbox.dev.email_code", code: message.code, to: message.to, idempotency_key: message.idempotencyKey })); }
}
export function selectMailer(): Mailer {
  if (process.env.RESEND_API_KEY) return new ResendMailer();
  if (process.env.LOCALBOX_LOCAL_SERVICES === "1" && process.env.LOCALBOX_DEV_PRINT_CODES === "1") return new DevLogMailer();
  throw new Error("email delivery is not configured");
}
