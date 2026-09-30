import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  parseAccounts,
  parseAcl,
  parseBuckets,
  parseCors,
  parseObjectLock,
  parseOwnership,
  parseTags,
  parseVersioning,
  ROOT,
} from "./parse.ts";
import { fixture, ROOT_ACCESS, SECRET_MARK } from "./test_support.ts";

const body = (name: string) => fixture(name).body;

Deno.test("parseAccounts keeps names, roles and ids, and no secret", () => {
  const raw = body("admin-list-users");
  // The gateway does send them: the test would prove nothing otherwise.
  assertEquals(raw.includes(SECRET_MARK), true);
  const accounts = parseAccounts(raw);
  assertEquals(accounts, [
    {
      access: "cnpg-forgejo",
      role: "user",
      userId: 0,
      groupId: 0,
      projectId: 0,
    },
    { access: "idle", role: "userplus", userId: 0, groupId: 0, projectId: 0 },
    { access: "ops", role: "admin", userId: 0, groupId: 0, projectId: 0 },
    {
      access: "restic-zitadel",
      role: "user",
      userId: 1001,
      groupId: 1001,
      projectId: 7,
    },
  ]);
  assertEquals(JSON.stringify(accounts).includes(SECRET_MARK), false);
  assertEquals(JSON.stringify(accounts).includes("Session"), false);
});

Deno.test("parseAccounts reads an empty list", () => {
  assertEquals(
    parseAccounts(
      '<?xml version="1.0"?><ListUserAccountsResult></ListUserAccountsResult>',
    ),
    [],
  );
});

Deno.test("parseBuckets marks root's buckets and never names root", () => {
  const buckets = parseBuckets(body("admin-list-buckets"), ROOT_ACCESS);
  assertEquals(buckets.map((b) => [b.name, b.owner, b.ownerIsRoot]), [
    ["cnpg-forgejo", "cnpg-forgejo", false],
    ["locked", "", true],
    ["ops", "ops", false],
    ["orphaned", "gone", false],
    ["restic-zitadel", "restic-zitadel", false],
    ["shared-scratch", "cnpg-forgejo", false],
  ]);
  assertEquals(JSON.stringify(buckets).includes(ROOT_ACCESS), false);
});

Deno.test("parseVersioning tells never-configured from enabled", () => {
  assertEquals(parseVersioning(body("bucket-cnpg-forgejo-versioning")), {
    versioning: "Off",
  });
  assertEquals(parseVersioning(body("bucket-shared-scratch-versioning")), {
    versioning: "Enabled",
  });
});

Deno.test("parseAcl reads owner and grants, and masks root", () => {
  assertEquals(parseAcl(body("bucket-shared-scratch-acl"), ROOT_ACCESS), {
    owner: "cnpg-forgejo",
    grants: [{
      granteeType: "CanonicalUser",
      grantee: "cnpg-forgejo",
      permission: "FULL_CONTROL",
    }],
  });
  const locked = parseAcl(body("bucket-locked-acl"), ROOT_ACCESS);
  assertEquals(locked.owner, ROOT);
  assertEquals(JSON.stringify(locked).includes(ROOT_ACCESS), false);
});

Deno.test("parseAcl reads a group grant", () => {
  const xml = `<AccessControlPolicy><Owner><ID>a</ID></Owner><AccessControlList>
    <Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group">
    <URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant>
    </AccessControlList></AccessControlPolicy>`;
  assertEquals(parseAcl(xml, ROOT_ACCESS).grants, [{
    granteeType: "Group",
    grantee: "http://acs.amazonaws.com/groups/global/AllUsers",
    permission: "READ",
  }]);
});

Deno.test("parseObjectLock reads the flag and a default retention", () => {
  assertEquals(parseObjectLock(body("bucket-locked-object-lock")), {
    enabled: true,
  });
  assertEquals(
    parseObjectLock(
      "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>",
    ),
    { enabled: true, mode: "COMPLIANCE", days: 30 },
  );
});

Deno.test("parseOwnership, parseCors and parseTags read their fixtures", () => {
  assertEquals(
    parseOwnership(body("bucket-restic-zitadel-ownershipControls")),
    "BucketOwnerPreferred",
  );
  assertEquals(parseCors(body("bucket-ops-cors")), [{
    allowedOrigins: ["https://example.org"],
    allowedMethods: ["GET"],
    allowedHeaders: [],
    exposeHeaders: [],
  }]);
  assertEquals(parseTags(body("bucket-cnpg-forgejo-tagging")), {
    site: "hov1",
    writer: "cnpg",
  });
});
