import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./project.ts";
import { PROJECT, ROLE } from "./fixtures.ts";
import { installFake, line, makeContext, page } from "./test_support.ts";

const SEARCH = "POST /management/v1/projects/_search";
const GET = "GET /management/v1/projects/300000000000000001";

Deno.test("list stores one resource per project", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH
      ? page([PROJECT, { ...PROJECT, id: "2", name: "annet" }])
      : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    assertEquals(written.map((w) => w.name), [
      "project-fabrikk",
      "project-annet",
    ]);
    assertEquals(written[0].data.roleAssertion, true);
    assertEquals(written[0].data.action, "observed");
  } finally {
    fake.restore();
  }
});

Deno.test("ensure leaves a project that already matches alone", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? page([PROJECT]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.ensure.execute(
      { name: "fabrikk", roleAssertion: true },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assertEquals(fake.calls.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("ensure creates a project that is not there", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([]);
    if (line(call) === "POST /management/v1/projects") {
      return { id: PROJECT.id };
    }
    if (line(call) === GET) return { project: PROJECT };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensure.execute({ name: "fabrikk" }, context);
    assertEquals(written[0].data.action, "created");
    assertEquals(fake.calls[1].body, {
      name: "fabrikk",
      projectRoleAssertion: false,
      projectRoleCheck: false,
      hasProjectCheck: false,
    });
  } finally {
    fake.restore();
  }
});

Deno.test("update sends the live values it was not asked to change", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === `PUT /management/v1/projects/${PROJECT.id}`) return {};
    if (line(call) === GET) {
      return { project: { ...PROJECT, name: "fabrikk-2" } };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.update.execute(
      { project: "fabrikk", name: "fabrikk-2" },
      context,
    );
    assertEquals(fake.calls[1].body, {
      name: "fabrikk-2",
      projectRoleAssertion: true,
      projectRoleCheck: false,
      hasProjectCheck: false,
    });
    assertEquals(written[0].data.action, "updated");
  } finally {
    fake.restore();
  }
});

Deno.test("setState deactivates, and says so when there is nothing to do", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (
      line(call) === `POST /management/v1/projects/${PROJECT.id}/_deactivate`
    ) {
      return {};
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.setState.execute(
      { project: "fabrikk", state: "inactive" },
      context,
    );
    assertEquals(written[0].data.action, "deactivated");
    await model.methods.setState.execute(
      { project: "fabrikk", state: "active" },
      context,
    );
    assertEquals(written[1].data.action, "unchanged");
  } finally {
    fake.restore();
  }
});

Deno.test("delete refuses a confirm that is not the live name", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? page([PROJECT]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.delete.execute(
          { project: "fabrikk", confirm: "fabrik", dryRun: false },
          context,
        ),
      Error,
      "refusing to delete",
    );
    assertEquals(written.length, 0);
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("delete under dryRun reports the plan and calls nothing", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? page([PROJECT]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.delete.execute(
      { project: "fabrikk", confirm: "fabrikk", dryRun: true },
      context,
    );
    assertEquals(written[0].data.action, "planned");
    assertEquals(written[0].data.deleted, false);
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("delete removes the project once the name matches", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === `DELETE /management/v1/projects/${PROJECT.id}`) {
      return {};
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.delete.execute(
      { project: "fabrikk", confirm: "fabrikk", dryRun: false },
      context,
    );
    assertEquals(written[0].data.deleted, true);
    assertEquals(written[0].data.action, "removed");
  } finally {
    fake.restore();
  }
});

Deno.test("roleEnsure creates a missing role and converges an existing one", async () => {
  const roleSearch = `POST /management/v1/projects/${PROJECT.id}/roles/_search`;
  let created = false;
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === roleSearch) return created ? page([ROLE]) : page([]);
    if (line(call) === `POST /management/v1/projects/${PROJECT.id}/roles`) {
      created = true;
      return {};
    }
    if (
      line(call) ===
        `PUT /management/v1/projects/${PROJECT.id}/roles/kube-admin`
    ) return {};
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.roleEnsure.execute({
      project: "fabrikk",
      roleKey: "kube-admin",
      displayName: "Kubernetes administrators",
      group: "kubernetes",
    }, context);
    assertEquals(written[0].data.action, "created");
    await model.methods.roleEnsure.execute({
      project: "fabrikk",
      roleKey: "kube-admin",
      displayName: "Kubernetes administrators",
      group: "kubernetes",
    }, context);
    assertEquals(written[1].data.action, "unchanged");
  } finally {
    fake.restore();
  }
});

Deno.test("roleRemove is a no-op when the role is already gone", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (
      line(call) === `POST /management/v1/projects/${PROJECT.id}/roles/_search`
    ) {
      return page([]);
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.roleRemove.execute(
      { project: "fabrikk", roleKey: "ghost", dryRun: false },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assertEquals(written[0].data.deleted, false);
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("delete is a no-op when the project is already gone", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? page([]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.delete.execute(
      { project: "ghost", confirm: "ghost", dryRun: false },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

const GRANT_SEARCH =
  `POST /management/v1/projects/${PROJECT.id}/grants/_search`;
const GRANTED_ORG = "900000000000000001";
const PROJECT_GRANT = {
  grantId: "700000000000000001",
  projectId: PROJECT.id,
  grantedOrgId: GRANTED_ORG,
  grantedOrgName: "Annen organisasjon",
  grantedRoleKeys: ["kube-admin"],
  state: "PROJECT_GRANT_STATE_ACTIVE",
};

Deno.test("projectGrantEnsure replaces the granted role set", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([PROJECT_GRANT]);
    if (
      line(call) ===
        `PUT /management/v1/projects/${PROJECT.id}/grants/${PROJECT_GRANT.grantId}`
    ) return {};
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.projectGrantEnsure.execute({
      project: "fabrikk",
      grantedOrgId: GRANTED_ORG,
      roleKeys: ["kube-readers"],
    }, context);
    const put = fake.calls.find((call) => call.method === "PUT");
    assertEquals(put?.body, { roleKeys: ["kube-readers"] });
    assertEquals(written[0].data.action, "updated");
  } finally {
    fake.restore();
  }
});

Deno.test("projectGrantEnsure with the same roles in another order changes nothing", async () => {
  const held = { ...PROJECT_GRANT, grantedRoleKeys: ["a", "b"] };
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([held]);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.projectGrantEnsure.execute({
      project: "fabrikk",
      grantedOrgId: GRANTED_ORG,
      roleKeys: ["b", "a"],
    }, context);
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "PUT"));
  } finally {
    fake.restore();
  }
});

Deno.test("projectGrantDelete wants the granted organization's name repeated", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([PROJECT_GRANT]);
    return undefined;
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.projectGrantDelete.execute({
          project: "fabrikk",
          grantedOrgId: GRANTED_ORG,
          confirm: GRANTED_ORG,
          dryRun: false,
        }, context),
      Error,
      "refusing to delete granted organization name",
    );
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("projectGrantDelete of a grant that was never made is a no-op", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return page([PROJECT]);
    if (line(call) === GRANT_SEARCH) return page([]);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.projectGrantDelete.execute({
      project: "fabrikk",
      grantedOrgId: GRANTED_ORG,
      confirm: "Annen organisasjon",
      dryRun: false,
    }, context);
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("project-grant methods carry the kinds a collection needs", () => {
  assertEquals(model.methods.projectGrantDelete.kind, "action");
  assertEquals(model.methods.projectGrantMemberRemove.kind, "action");
  assertEquals(model.methods.projectGrantEnsure.kind, "create");
  assertEquals(model.methods.projectGrantList.kind, "list");
});
