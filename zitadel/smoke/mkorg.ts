/**
 * Scaffolding for the smoke suite: create a second organization to grant a
 * project to.
 *
 * `@dataverket/zitadel/org` is deliberately read-only — creating an
 * organization decides who exists on an instance — so the test that needs a
 * second one makes it here instead, with the same service-user key the models
 * use.
 *
 * Usage: deno run --allow-read --allow-net --allow-env mkorg.ts <keyFile> <apiUrl> <name>
 *
 * @module
 */
import { call, getToken } from "../api.ts";

const [keyFile, apiUrl, name] = Deno.args;
if (!keyFile || !apiUrl || !name) {
  console.error("usage: mkorg.ts <keyFile> <apiUrl> <name>");
  Deno.exit(2);
}
const globalArgs = { apiUrl, keyJsonFile: keyFile, httpTimeoutMs: 30000 };
await getToken(globalArgs);
const existing = await call(globalArgs, {
  method: "POST",
  path: "/v2/organizations/_search",
  body: {
    queries: [{
      nameQuery: { name, method: "ORGANIZATION_NAME_METHOD_EQUALS" },
    }],
  },
});
const found =
  (existing.body.result as { id: string; name: string }[] | undefined)
    ?.find((row) => row.name === name);
if (found) {
  console.log(found.id);
  Deno.exit(0);
}
const created = await call(globalArgs, {
  method: "POST",
  path: "/v2/organizations",
  body: { name },
});
console.log(String(created.body.organizationId ?? created.body.id ?? ""));
