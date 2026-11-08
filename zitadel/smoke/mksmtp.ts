/**
 * Scaffolding for the smoke suite: an SMTP email provider on the throwaway
 * instance, so that `settings read` has one to store. Nothing is ever sent:
 * the host does not exist, and the provider's password is a throwaway string
 * that the read must not store.
 *
 * `@dataverket/zitadel/settings` does not write email providers, so the test
 * that needs one makes it here, with the same service-user key the models use.
 *
 * Usage: deno run --allow-read --allow-net --allow-env mksmtp.ts <keyFile> <apiUrl> <description>
 *
 * @module
 */
import { call, getToken } from "../api.ts";

const [keyFile, apiUrl, description] = Deno.args;
if (!keyFile || !apiUrl || !description) {
  console.error("usage: mksmtp.ts <keyFile> <apiUrl> <description>");
  Deno.exit(2);
}
const globalArgs = { apiUrl, keyJsonFile: keyFile, httpTimeoutMs: 30000 };
await getToken(globalArgs);
const existing = await call(globalArgs, {
  method: "POST",
  path: "/admin/v1/email/_search",
  body: {},
});
const found = (existing.body.result as
  | { id: string; description?: string }[]
  | undefined)?.find((row) => row.description === description);
if (found) {
  console.log(found.id);
  Deno.exit(0);
}
const created = await call(globalArgs, {
  method: "POST",
  path: "/admin/v1/email/smtp",
  body: {
    description,
    senderAddress: "noreply@smoke.invalid",
    senderName: "Smoke",
    tls: true,
    host: "mail.smoke.invalid:587",
    user: "noreply@smoke.invalid",
    password: "SMTPMARKER-not-a-real-password",
  },
});
console.log(String(created.body.id ?? ""));
