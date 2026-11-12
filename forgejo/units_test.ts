import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./units.ts";
import { harness, writes } from "./stub_test.ts";

const m = extension.methods[0].repo_units_ensure;
const REPO = "/api/v1/repos/acme/tool";
const units = { has_actions: false, has_packages: true, has_projects: true };

Deno.test("repo_units_ensure sends only the unit that differs and records what changed", async () => {
  const h = harness({
    [`GET ${REPO}`]: { status: 200, body: units },
    [`PATCH ${REPO}`]: { status: 200, body: { ...units, has_actions: true } },
  });
  await m.execute({
    owner: "acme",
    name: "tool",
    hasActions: true,
    hasPackages: true,
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{ has_actions: true }]);
  const w = h.written()[0];
  assertEquals([w.spec, w.name, w.data.action, w.data.changed], [
    "repoUnits",
    "repo-units-acme-tool",
    "updated",
    ["hasActions"],
  ]);
});

Deno.test("repo_units_ensure writes nothing when the units already match", async () => {
  const h = harness({ [`GET ${REPO}`]: { status: 200, body: units } });
  await m.execute(
    { owner: "acme", name: "tool", hasProjects: true },
    h.context,
  );
  assertEquals([writes(h.calls), h.written()[0].data.action], [
    [],
    "unchanged",
  ]);
});

Deno.test("repo_units_ensure refuses a change the forge accepts and does not apply", async () => {
  const h = harness({
    [`GET ${REPO}`]: { status: 200, body: units },
    [`PATCH ${REPO}`]: { status: 200, body: units },
  });
  await assertRejects(
    () =>
      m.execute({ owner: "acme", name: "tool", hasActions: true }, h.context),
    Error,
    "the forge accepted the change but did not apply hasActions",
  );
  assertEquals(h.written(), []);
});

Deno.test("repo_units_ensure names a repository that is not there", async () => {
  const h = harness({ [`GET ${REPO}`]: { status: 404 } });
  await assertRejects(
    () =>
      m.execute({ owner: "acme", name: "tool", hasActions: true }, h.context),
    Error,
    "repository acme/tool does not exist",
  );
});
