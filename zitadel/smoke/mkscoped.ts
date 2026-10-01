/**
 * Scaffolding for the smoke suite: a machine user that may do less than the
 * instance's first one, and a key file for it.
 *
 * The suite otherwise runs as the owner the instance was born with, which says
 * nothing about what a narrower key is allowed and refused. This makes the two
 * a deployment would actually hand out: a reader of the whole instance
 * (`IAM_OWNER_VIEWER`), and an owner of one project (`PROJECT_OWNER`) with no
 * role in the organization. Membership of the instance is not something the
 * model types administer, so it is done here.
 *
 * Usage: deno run --allow-read --allow-write --allow-net --allow-env mkscoped.ts \
 *          <adminKeyFile> <apiUrl> <username> <outFile> viewer|owner:<project>
 *
 * @module
 */
import {
  call,
  fromBase64,
  getToken,
  type Json,
  mgmt,
  seg,
  v2,
} from "../api.ts";

const [keyFile, apiUrl, username, outFile, scope] = Deno.args;
if (!keyFile || !apiUrl || !username || !outFile || !scope) {
  console.error(
    "usage: mkscoped.ts <adminKeyFile> <apiUrl> <username> <outFile> viewer|owner:<project>",
  );
  Deno.exit(2);
}
const globalArgs = { apiUrl, keyJsonFile: keyFile, httpTimeoutMs: 30000 };
await getToken(globalArgs);

const rows = (body: Json): Json[] =>
  Array.isArray(body.result) ? body.result as Json[] : [];

const org = await call(globalArgs, { method: "GET", path: mgmt("/orgs/me") });
const orgId = String((org.body.org as Json).id);

const found = await call(globalArgs, {
  method: "POST",
  path: v2("/users"),
  body: {
    queries: [{
      userNameQuery: { userName: username, method: "TEXT_QUERY_METHOD_EQUALS" },
    }],
  },
});
let userId = String(
  rows(found.body).find((row) => row.username === username)?.userId ?? "",
);
if (!userId) {
  const created = await call(globalArgs, {
    method: "POST",
    path: v2("/users/new"),
    body: { organizationId: orgId, username, machine: { name: username } },
  });
  userId = String(created.body.id ?? created.body.userId);
}

/** Add the user as a member with one role, unless it is one already. */
async function member(path: string, role: string): Promise<void> {
  const held = await call(globalArgs, {
    method: "POST",
    path: `${path}/_search`,
    body: { queries: [{ userIdQuery: { userId } }] },
  });
  if (rows(held.body).some((row) => row.userId === userId)) return;
  await call(globalArgs, {
    method: "POST",
    path,
    body: { userId, roles: [role] },
  });
}

if (scope === "viewer") {
  await member("/admin/v1/members", "IAM_OWNER_VIEWER");
} else if (scope.startsWith("owner:")) {
  const name = scope.slice("owner:".length);
  const search = await call(globalArgs, {
    method: "POST",
    path: mgmt("/projects/_search"),
    body: {
      queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    },
  });
  let projectId = String(
    rows(search.body).find((row) => row.name === name)?.id ?? "",
  );
  if (!projectId) {
    const created = await call(globalArgs, {
      method: "POST",
      path: mgmt("/projects"),
      body: { name },
    });
    projectId = String(created.body.id);
  }
  await member(mgmt(`/projects/${seg(projectId)}/members`), "PROJECT_OWNER");
} else {
  console.error(`unknown scope ${scope}`);
  Deno.exit(2);
}

const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const key = await call(globalArgs, {
  method: "POST",
  path: v2(`/users/${seg(userId)}/keys`),
  body: { expirationDate: expires },
});
await Deno.writeTextFile(outFile, fromBase64(String(key.body.keyContent)), {
  mode: 0o600,
});
console.log(userId);
