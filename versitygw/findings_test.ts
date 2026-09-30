import { assertEquals } from "jsr:@std/assert@1.0.13";
import { findings, publicReasons, RULES } from "./findings.ts";
import type { BucketSettings } from "./parse.ts";

function settings(overrides: Partial<BucketSettings> = {}): BucketSettings {
  return {
    bucket: "b",
    versioning: "Off",
    policy: null,
    acl: { owner: "b", grants: [] },
    objectLock: null,
    objectOwnership: "BucketOwnerEnforced",
    cors: null,
    tags: null,
    ...overrides,
  };
}

const user = (access: string, role = "user") => ({
  access,
  role,
  userId: 0,
  groupId: 0,
  projectId: 0,
});

Deno.test("a gateway laid out by the rule is clean", () => {
  assertEquals(
    findings({
      accounts: [user("a"), user("b")],
      buckets: [
        { name: "a", owner: "a", ownerIsRoot: false },
        { name: "b", owner: "b", ownerIsRoot: false },
      ],
      settings: [settings({ bucket: "a" }), settings({ bucket: "b" })],
    }, { rules: RULES, allowedRoles: ["user"] }),
    [],
  );
});

Deno.test("each rule fires on its own case", () => {
  const inventory = {
    accounts: [user("a"), user("idle"), user("ops", "admin")],
    buckets: [
      { name: "a", owner: "a", ownerIsRoot: false },
      { name: "x", owner: "a", ownerIsRoot: false },
      { name: "gone", owner: "nobody", ownerIsRoot: false },
      { name: "r", owner: "", ownerIsRoot: true },
      { name: "ops", owner: "ops", ownerIsRoot: false },
    ],
    settings: [settings({ bucket: "a", versioning: "Enabled" })],
  };
  assertEquals(findings(inventory, { rules: RULES, allowedRoles: ["user"] }), [
    { rule: "account-owns-nothing", subject: "idle", detail: "owns no bucket" },
    {
      rule: "account-role",
      subject: "ops",
      detail: "role admin, allowed: user",
    },
    {
      rule: "bucket-owner-missing",
      subject: "gone",
      detail: "owner nobody is not an account",
    },
    {
      rule: "bucket-owner-not-same-named",
      subject: "r",
      detail: "owned by the root account",
    },
    { rule: "bucket-owner-not-same-named", subject: "x", detail: "owned by a" },
    { rule: "versioning-enabled", subject: "a", detail: "versioning enabled" },
  ]);
  assertEquals(
    findings(inventory, {
      rules: ["account-role"],
      allowedRoles: ["user", "admin"],
    }),
    [],
  );
});

Deno.test("publicReasons finds anonymous policy principals and public groups", () => {
  const policy = (principal: unknown, effect = "Allow") =>
    JSON.stringify({
      Statement: [{
        Effect: effect,
        Principal: principal,
        Action: "s3:GetObject",
      }],
    });
  assertEquals(publicReasons(settings({ policy: policy("*") })), [
    "policy allows anyone s3:GetObject",
  ]);
  assertEquals(
    publicReasons(settings({ policy: policy({ AWS: ["a", "*"] }) })).length,
    1,
  );
  assertEquals(publicReasons(settings({ policy: policy("*", "Deny") })), []);
  assertEquals(publicReasons(settings({ policy: policy({ AWS: "a" }) })), []);
  assertEquals(publicReasons(settings({ policy: "{" })), [
    "policy is not valid JSON",
  ]);
  assertEquals(
    publicReasons(settings({
      acl: {
        owner: "b",
        grants: [{
          granteeType: "Group",
          grantee: "http://acs.amazonaws.com/groups/global/AllUsers",
          permission: "READ",
        }],
      },
    })),
    ["ACL grants READ to http://acs.amazonaws.com/groups/global/AllUsers"],
  );
});
