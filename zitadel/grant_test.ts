import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./grant.ts";
import { GRANT, HUMAN_USER, PROJECT } from "./fixtures.ts";
import { installFake, line, makeContext, page } from "./test_support.ts";

const USER_SEARCH = "POST /v2/users";
const PROJECT_SEARCH = "POST /management/v1/projects/_search";
const GRANT_SEARCH = "POST /management/v1/users/grants/_search";

function users(rows: unknown[]) {
  return { result: rows, details: { totalResult: String(rows.length) } };
}

Deno.test("list stores one resource per grant", async () => {
  const fake = installFake((call) =>
    line(call) === GRANT_SEARCH ? page([GRANT]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute(
      { user: undefined, project: undefined },
      context,
    );
    assertEquals(written[0].data.roleKeys, ["kube-admin"]);
    assertEquals(written[0].data.state, "active");
  } finally {
    fake.restore();
  }
});

Deno.test("ensure converges the role set rather than adding to it", async () => {
  const fake = installFake((call) => {
    if (line(call) === USER_SEARCH) return users([HUMAN_USER]);
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([GRANT]);
    if (
      line(call) ===
        `PUT /management/v1/users/${HUMAN_USER.userId}/grants/${GRANT.id}`
    ) return {};
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensure.execute(
      { user: "kari", project: "fabrikk", roleKeys: ["kube-readers"] },
      context,
    );
    const put = fake.calls.find((call) => call.method === "PUT");
    assertEquals(put?.body, { roleKeys: ["kube-readers"] });
    assertEquals(written[0].data.action, "updated");
  } finally {
    fake.restore();
  }
});

Deno.test("ensure is a no-op when the same roles are held in another order", async () => {
  const held = { ...GRANT, roleKeys: ["kube-admin", "kube-readers"] };
  const fake = installFake((call) => {
    if (line(call) === USER_SEARCH) return users([HUMAN_USER]);
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([held]);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensure.execute(
      {
        user: "kari",
        project: "fabrikk",
        roleKeys: ["kube-readers", "kube-admin"],
      },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "PUT"));
  } finally {
    fake.restore();
  }
});

Deno.test("delete reports a dry run, then removes the grant", async () => {
  const fake = installFake((call) => {
    if (line(call) === USER_SEARCH) return users([HUMAN_USER]);
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([GRANT]);
    if (
      line(call) ===
        `DELETE /management/v1/users/${HUMAN_USER.userId}/grants/${GRANT.id}`
    ) return {};
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.delete.execute(
      { user: "kari", project: "fabrikk", dryRun: true },
      context,
    );
    assertEquals(written[0].data.deleted, false);
    assert(fake.calls.every((call) => call.method !== "DELETE"));
    await model.methods.delete.execute(
      { user: "kari", project: "fabrikk", dryRun: false },
      context,
    );
    assertEquals(written[1].data.deleted, true);
  } finally {
    fake.restore();
  }
});

Deno.test("setState refuses a grant that is not there", async () => {
  const fake = installFake((call) => {
    if (line(call) === USER_SEARCH) return users([HUMAN_USER]);
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([]);
    return undefined;
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.setState.execute(
          { user: "kari", project: "fabrikk", state: "inactive" },
          context,
        ),
      Error,
      "no grant on project",
    );
  } finally {
    fake.restore();
  }
});
