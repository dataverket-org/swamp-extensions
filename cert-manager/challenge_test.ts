import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./challenge.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";
import { assertNoSecrets, challenge } from "./test_support.ts";

// ───── the methods, through createModelTestContext with a stub kubectl ─────

const M = model.methods;
const R = "challenges.acme.cert-manager.io";
const OWNER = { uid: "uid-owner", name: "owner" };

Deno.test("list records each Challenge and one inventory, and no secret", async () => {
  using h = harness({
    [`kubectl get ${R} -n acme-test`]: {
      stdout: list([challenge("one", OWNER), challenge("two", OWNER)]),
    },
  });
  await M.list.execute({ namespace: "acme-test" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["challenge", "acme-test--one"],
    ["challenge", "acme-test--two"],
    ["inventory", "inventory_ns_acme-test"],
  ]);
  assertEquals(w[2].data.count, 2);
  assertEquals(w[0].data.name, "one");
  assertEquals(h.logs().at(-1), "Found 2 Challenge objects, 2 not healthy");
  assertNoSecrets(w, h.logs());
});

Deno.test("list with no namespace anywhere reads every namespace", async () => {
  using h = harness({ [`kubectl get ${R} -A`]: { stdout: list([]) } });
  await M.list.execute({}, h.context);
  assertEquals(h.written().map((x) => x.name), ["inventory_all"]);
});

Deno.test("list passes on a refusal and records nothing", async () => {
  using h = harness({
    [`kubectl get ${R} -n acme-test`]: forbidden("list", R),
  });
  await assertRejects(
    () => M.list.execute({ namespace: "acme-test" }, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});

Deno.test("list says cert-manager is not installed when the type is not served", async () => {
  using h = harness({
    [`kubectl get ${R} -n acme-test`]: {
      code: 1,
      stderr: `error: the server doesn't have a resource type "${
        R.split(".")[0]
      }"`,
    },
  });
  await assertRejects(
    () => M.list.execute({ namespace: "acme-test" }, h.context),
    Error,
    "cert-manager is not installed",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records the one Challenge asked for", async () => {
  using h = harness({
    [`kubectl get ${R} one -n acme-test`]: { stdout: challenge("one", OWNER) },
  });
  await M.get.execute({ name: "one", namespace: "acme-test" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "challenge",
    "acme-test--one",
  ]]);
  assertEquals([w[0].data.namespace, w[0].data.name], ["acme-test", "one"]);
  assertEquals(h.logs().at(-1), "Read Challenge one");
  assertNoSecrets(w, h.logs());
});

Deno.test("get of a missing Challenge says it does not exist and records nothing", async () => {
  using h = harness({
    [`kubectl get ${R} gone -n acme-test`]: notFound(R, "gone"),
  });
  await assertRejects(
    () => M.get.execute({ name: "gone", namespace: "acme-test" }, h.context),
    Error,
    "Challenge acme-test/gone does not exist",
  );
  assertEquals(h.written(), []);
});

Deno.test("get without a namespace is refused before kubectl runs", async () => {
  using h = harness({});
  await assertRejects(() => M.get.execute({ name: "one" }, h.context));
  assertEquals([h.calls, h.written()], [[], []]);
});
