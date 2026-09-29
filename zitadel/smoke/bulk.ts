/**
 * Scaffolding for the smoke suite: make more of something than fits on one
 * page, so the paging in `searchAll` and `searchAllV2` is exercised against a
 * real server rather than a fake.
 *
 * Zitadel pages at a hundred, and the two API versions disagree about where
 * paging goes — v1 takes `query`, v2 takes `pagination` — so a list that stops
 * at the first page is a bug no unit test with a fake would catch.
 *
 * Usage: deno run --allow-read --allow-net --allow-env bulk.ts <keyFile> <apiUrl> <what> <count> [projectId]
 *   what: users | projects | roles
 *
 * @module
 */
import { call, getToken, mgmt, seg, v2 } from "../api.ts";

const [keyFile, apiUrl, what, countArg, projectId] = Deno.args;
if (!keyFile || !apiUrl || !what || !countArg) {
  console.error(
    "usage: bulk.ts <keyFile> <apiUrl> <users|projects|roles> <count> [projectId]",
  );
  Deno.exit(2);
}
const count = Number(countArg);
const globalArgs = { apiUrl, keyJsonFile: keyFile, httpTimeoutMs: 30000 };
await getToken(globalArgs);

const orgResult = await call(globalArgs, {
  method: "GET",
  path: mgmt("/orgs/me"),
});
const orgId = String(
  (orgResult.body.org as { id?: string } | undefined)?.id ?? "",
);

let made = 0;
for (let i = 0; i < count; i++) {
  const n = String(i).padStart(3, "0");
  try {
    if (what === "users") {
      await call(globalArgs, {
        method: "POST",
        path: v2("/users/new"),
        body: {
          organizationId: orgId,
          username: `bulk-${n}`,
          machine: {
            name: `Bulk ${n}`,
            accessTokenType: "ACCESS_TOKEN_TYPE_BEARER",
          },
        },
      });
    } else if (what === "projects") {
      await call(globalArgs, {
        method: "POST",
        path: mgmt("/projects"),
        body: { name: `bulk-project-${n}` },
      });
    } else if (what === "roles") {
      if (!projectId) throw new Error("roles need a projectId");
      await call(globalArgs, {
        method: "POST",
        path: mgmt(`/projects/${seg(projectId)}/roles`),
        body: { roleKey: `bulk-role-${n}`, displayName: `Bulk role ${n}` },
      });
    } else {
      throw new Error(`unknown kind ${what}`);
    }
    made++;
  } catch (err) {
    // Already there from an earlier run is fine; anything else is not.
    const message = err instanceof Error ? err.message : String(err);
    if (
      !/already exists|AlreadyExists|Errors.User.AlreadyExisting|Errors.Project/i
        .test(message)
    ) {
      console.error(message);
      Deno.exit(1);
    }
  }
}
console.log(made);
