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

Deno.test("list names a grant by username and project, as ensure does", async () => {
  const row = { ...GRANT, userName: "kari", projectName: "fabrikk" };
  const fake = installFake((call) => {
    if (line(call) === USER_SEARCH) return users([HUMAN_USER]);
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([row]);
    return undefined;
  });
  const listed = makeContext();
  const ensured = makeContext();
  try {
    await model.methods.list.execute(
      { user: undefined, project: undefined },
      listed.context,
    );
    await model.methods.ensure.execute(
      { user: "kari", project: "fabrikk", roleKeys: ["kube-admin"] },
      ensured.context,
    );
    assertEquals(listed.written[0].name, "grant-kari-fabrikk");
    assertEquals(listed.written[0].name, ensured.written[0].name);
  } finally {
    fake.restore();
  }
});

Deno.test("list falls back to an id only for the name Zitadel did not send", async () => {
  const fake = installFake((call) =>
    line(call) === GRANT_SEARCH
      ? page([
        GRANT,
        { ...GRANT, id: "600000000000000002", userName: "kari" },
        { ...GRANT, id: "600000000000000003", userName: "", projectName: "p" },
      ])
      : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute(
      { user: undefined, project: undefined },
      context,
    );
    assertEquals(written.map((entry) => entry.name), [
      `grant-${GRANT.userId}-${GRANT.projectId}`,
      `grant-kari-${GRANT.projectId}`,
      `grant-${GRANT.userId}-p`,
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("two grants of one user on one project do not overwrite each other", async () => {
  const row = { ...GRANT, userName: "kari", projectName: "fabrikk" };
  const fake = installFake((call) =>
    line(call) === GRANT_SEARCH
      ? page([row, { ...row, id: "600000000000000009", roleKeys: ["other"] }])
      : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute(
      { user: undefined, project: undefined },
      context,
    );
    assertEquals(written.length, 2);
    assertEquals(written[0].name, "grant-kari-fabrikk");
    assert(written[1].name.startsWith("grant-kari-fabrikk-"));
  } finally {
    fake.restore();
  }
});

Deno.test("list forgets the id-named record of a grant it now stores by name", async () => {
  const fake = installFake((call) =>
    line(call) === GRANT_SEARCH
      ? page([{ ...GRANT, userName: "kari", projectName: "fabrikk" }])
      : undefined
  );
  const { context, written, forgotten } = makeContext();
  try {
    await model.methods.list.execute(
      { user: undefined, project: undefined },
      context,
    );
    assertEquals(written[0].name, "grant-kari-fabrikk");
    assertEquals(forgotten, [`grant-${GRANT.userId}-${GRANT.projectId}`]);
  } finally {
    fake.restore();
  }
});

Deno.test("list forgets nothing when the id is the only name there is", async () => {
  const fake = installFake((call) =>
    line(call) === GRANT_SEARCH ? page([GRANT]) : undefined
  );
  const { context, written, forgotten } = makeContext();
  try {
    await model.methods.list.execute(
      { user: undefined, project: undefined },
      context,
    );
    assertEquals(written[0].name, `grant-${GRANT.userId}-${GRANT.projectId}`);
    assertEquals(forgotten, []);
  } finally {
    fake.restore();
  }
});

Deno.test("every type carries an upgrade to the version it declares", async () => {
  for (
    const file of [
      "action",
      "app",
      "grant",
      "org",
      "project",
      "settings",
      "user",
    ]
  ) {
    const loaded = (await import(`./${file}.ts`)).model as {
      version: string;
      upgrades: {
        toVersion: string;
        upgradeAttributes: (
          old: Record<string, unknown>,
        ) => Record<string, unknown>;
      }[];
    };
    const last = loaded.upgrades[loaded.upgrades.length - 1];
    assertEquals(last.toVersion, loaded.version, file);
    const args = { apiUrl: "https://zitadel.example.org", keyJsonFile: "~/k" };
    assertEquals(last.upgradeAttributes(args), args, file);
  }
});
