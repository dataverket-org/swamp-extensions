import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./instance.ts";
import { installFake, line, makeContext, page } from "./test_support.ts";

const ME = "GET /admin/v1/instances/me";
const DOMAINS = "POST /admin/v1/domains/_search";
const TRUSTED = "POST /admin/v1/trusted_domains/_search";
const MEMBERS = "POST /admin/v1/members/_search";

const instance = {
  id: "389916413805987103",
  name: "dataverket",
  version: "v4.19.3",
  state: "INSTANCE_STATE_RUNNING",
};
const domains = [
  { domain: "zitadel-obgyom.example.org", primary: false, generated: true },
  { domain: "id.example.org", primary: true, generated: false },
];
const trusted = [{ domain: "login.example.org" }, { domain: "id.example.org" }];

Deno.test("read stores the instance, its domains and its trusted domains", async () => {
  const fake = installFake((call) => {
    if (line(call) === ME) return { instance };
    if (line(call) === DOMAINS) return page(domains);
    if (line(call) === TRUSTED) return page(trusted);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.read.execute({}, context);
    assertEquals(written[0].spec, "instance");
    assertEquals(written[0].name, `instance-${instance.id}`);
    assertEquals(written[0].data.state, "running");
    assertEquals(written[0].data.version, "v4.19.3");
    const stored = written.filter((w) => w.spec === "instance-domain");
    assertEquals(stored.length, 2);
    assertEquals(stored[1].data.primary, true);
    assertEquals(stored[0].data.generated, true);
    assertEquals(stored[0].data.instanceId, instance.id);
    assertEquals(
      written.filter((w) => w.spec === "trusted-domain").map((w) => w.name),
      ["trusted-domain-login-example-org", "trusted-domain-id-example-org"],
    );
  } finally {
    fake.restore();
  }
});

Deno.test("memberList stores every holder of an instance role with the roles", async () => {
  const fake = installFake((call) => {
    if (line(call) === MEMBERS) {
      return page([
        {
          userId: "1",
          roles: ["IAM_OWNER"],
          preferredLoginName: "kari@example.org",
          email: "kari@example.org",
          displayName: "Kari Nordmann",
          userType: "TYPE_HUMAN",
          userResourceOwner: "7",
        },
        {
          userId: "2",
          roles: ["IAM_OWNER_VIEWER", "IAM_ORG_MANAGER"],
          preferredLoginName: "reader@example.org",
          userType: "TYPE_MACHINE",
        },
      ]);
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.memberList.execute({}, context);
    assertEquals(written.map((w) => w.name), [
      "member-kari-example-org",
      "member-reader-example-org",
    ]);
    assertEquals(written[0].data.roles, ["IAM_OWNER"]);
    assertEquals(written[0].data.userType, "human");
    assertEquals(written[0].data.orgId, "7");
    assertEquals(written[1].data.roles, [
      "IAM_OWNER_VIEWER",
      "IAM_ORG_MANAGER",
    ]);
    assertEquals(written[1].data.userType, "machine");
  } finally {
    fake.restore();
  }
});

Deno.test("trustedDomainAdd adds a missing domain and leaves a trusted one alone", async () => {
  const added: unknown[] = [];
  const fake = installFake((call) => {
    if (line(call) === TRUSTED) return page(trusted);
    if (line(call) === "POST /admin/v1/trusted_domains") {
      added.push(call.body);
      return {};
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.trustedDomainAdd.execute(
      { domain: "forum.example.org" },
      context,
    );
    assertEquals(added, [{ domain: "forum.example.org" }]);
    assertEquals(written[0].data.action, "created");
    await model.methods.trustedDomainAdd.execute(
      { domain: "login.example.org" },
      context,
    );
    assertEquals(added.length, 1);
    assertEquals(written[1].data.action, "unchanged");
  } finally {
    fake.restore();
  }
});

Deno.test("trustedDomainRemove verifies first: present, confirm, dryRun, then removes", async () => {
  const removed: string[] = [];
  const fake = installFake((call) => {
    if (line(call) === TRUSTED) return page(trusted);
    if (
      call.method === "DELETE" &&
      call.path.startsWith("/admin/v1/trusted_domains/")
    ) {
      removed.push(call.path);
      return {};
    }
    return undefined;
  });
  const { context, written, forgotten } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.trustedDomainRemove.execute(
          {
            domain: "nobody.example.org",
            confirm: "nobody.example.org",
            dryRun: false,
          },
          context,
        ),
      Error,
      "is not trusted",
    );
    await assertRejects(
      () =>
        model.methods.trustedDomainRemove.execute(
          { domain: "login.example.org", confirm: "other", dryRun: false },
          context,
        ),
      Error,
      "refusing to delete trusted domain",
    );
    await model.methods.trustedDomainRemove.execute(
      {
        domain: "login.example.org",
        confirm: "login.example.org",
        dryRun: true,
      },
      context,
    );
    assertEquals(removed, []);
    assertEquals(written[0].data.action, "planned");
    await model.methods.trustedDomainRemove.execute(
      {
        domain: "login.example.org",
        confirm: "login.example.org",
        dryRun: false,
      },
      context,
    );
    assertEquals(removed, ["/admin/v1/trusted_domains/login.example.org"]);
    assertEquals(forgotten, ["trusted-domain-login-example-org"]);
    assertEquals(written[1].data.action, "removed");
  } finally {
    fake.restore();
  }
});
