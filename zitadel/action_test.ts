import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { __internal, model } from "./action.ts";
import { assertNoPlanted, fail, harness } from "./test_support.ts";

Deno.test("a condition has to be exactly one thing", () => {
  const error = assertThrows(() => __internal.conditionBody({}), Error);
  assert(error.message.includes("exactly one condition"));
  assertEquals(__internal.conditionBody({ event: "user.human.added" }), {
    event: { event: "user.human.added" },
  });
  assertEquals(__internal.conditionKey({ event: { all: true } }), "event-all");
});

Deno.test("a target's delivery style decides which body field is sent", () => {
  assertEquals(__internal.styleBody("webhook", true), {
    restWebhook: { interruptOnError: true },
  });
  assertEquals(__internal.styleBody("call", false), {
    restCall: { interruptOnError: false },
  });
  assertEquals(__internal.styleBody("async", true), { restAsync: {} });
});

Deno.test("every destructive method is an action, not a delete", () => {
  assertEquals(model.methods.delete.kind, "action");
  assertEquals(model.methods.executionRemove.kind, "action");
  assertEquals(model.methods.keyRemove.kind, "action");
  assertEquals(model.methods.ensure.kind, "create");
});

const T = { id: "t1", name: "hook", endpoint: "https://hooks.example.org" };
const SEARCH = "POST /v2/actions/targets/search";
const found = { targets: [T] };
const none = { targets: [] };
const m = model.methods;

Deno.test("list stores every target", async () => {
  using h = harness({ [SEARCH]: found });
  await m.list.execute({}, h.context);
  assertEquals(h.written().map((w) => [w.spec, w.name]), [[
    "target",
    "target-hook",
  ]]);
  assertNoPlanted(h);
});

Deno.test("list fails on an API failure and writes nothing", async () => {
  using h = harness({ [SEARCH]: fail(403) });
  await assertRejects(() => m.list.execute({}, h.context), Error, "HTTP 403");
  assertEquals(h.written(), []);
});

Deno.test("get resolves a target by name and stores it", async () => {
  using h = harness({ [SEARCH]: found });
  await m.get.execute({ target: "hook" }, h.context);
  assertEquals(h.written()[0].data.id, "t1");
});

Deno.test("get refuses a target that is neither a name nor an id", async () => {
  using h = harness({
    [SEARCH]: none,
    "GET /v2/actions/targets/nope": fail(404),
  });
  await assertRejects(
    () => m.get.execute({ target: "nope" }, h.context),
    Error,
    'no target "nope"',
  );
  assertEquals(h.written(), []);
});

Deno.test("ensure creates a missing target and stores its signing key once", async () => {
  using h = harness({
    [SEARCH]: none,
    "POST /v2/actions/targets": { id: "t1", signingKey: "sk-1" },
    "GET /v2/actions/targets/t1": { target: T },
  });
  await m.ensure.execute(
    m.ensure.arguments.parse({ name: "hook", endpoint: T.endpoint }),
    h.context,
  );
  const create = h.writes().find((c) => c.path === "/v2/actions/targets")!;
  assertEquals((create.body as Record<string, unknown>).restWebhook, {
    interruptOnError: false,
  });
  assertEquals(h.written().map((w) => [w.spec, w.data.action]), [
    ["target", "created"],
    ["target-credential", "created"],
  ]);
  assertEquals(h.written()[1].data.signingKey, "sk-1");
});

Deno.test("ensure explains an endpoint Zitadel will not call", async () => {
  using h = harness({
    [SEARCH]: none,
    "POST /v2/actions/targets": fail(400, "Errors.DeniedURL"),
  });
  await assertRejects(
    () =>
      m.ensure.execute(
        m.ensure.arguments.parse({
          name: "hook",
          endpoint: "http://localhost",
        }),
        h.context,
      ),
    Error,
    "Zitadel will not call http://localhost",
  );
  assertEquals(h.written(), []);
});

Deno.test("delete removes a target whose name is confirmed", async () => {
  using h = harness({
    [SEARCH]: found,
    "DELETE /v2/actions/targets/t1": {},
  });
  await m.delete.execute(
    m.delete.arguments.parse({ target: "hook", confirm: "hook" }),
    h.context,
  );
  assertEquals(h.written()[0].data.action, "removed");
  assertEquals(h.forgotten, ["target-hook"]);
});

Deno.test("delete refuses a confirm that is not the live name", async () => {
  using h = harness({ [SEARCH]: found });
  await assertRejects(
    () =>
      m.delete.execute(
        m.delete.arguments.parse({ target: "hook", confirm: "other" }),
        h.context,
      ),
    Error,
    "refusing to delete",
  );
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
  assertEquals(h.written(), []);
});

Deno.test("delete with dryRun only reports", async () => {
  using h = harness({ [SEARCH]: found });
  await m.delete.execute(
    m.delete.arguments.parse({ target: "hook", confirm: "hook", dryRun: true }),
    h.context,
  );
  assertEquals(h.written()[0].data.action, "planned");
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
});

const EXEC = "POST /v2/actions/executions/search";
const COND = { event: { event: "user.human.added" } };

Deno.test("executionList stores each execution by its condition", async () => {
  using h = harness({ [EXEC]: { executions: [{ condition: COND }] } });
  await m.executionList.execute({}, h.context);
  assertEquals(h.written()[0].spec, "execution");
});

Deno.test("executionList fails on an API failure", async () => {
  using h = harness({ [EXEC]: fail(500) });
  await assertRejects(
    () => m.executionList.execute({}, h.context),
    Error,
    "HTTP 500",
  );
  assertEquals(h.written(), []);
});

Deno.test("executionSet binds a condition to the resolved targets", async () => {
  using h = harness({ [SEARCH]: found, "PUT /v2/actions/executions": {} });
  await m.executionSet.execute(
    m.executionSet.arguments.parse({
      event: "user.human.added",
      targets: ["hook"],
    }),
    h.context,
  );
  assertEquals(h.writes().at(-1)!.body, { condition: COND, targets: ["t1"] });
  assertEquals(h.written()[0].name, "execution-event-user-human-added");
});

Deno.test("executionSet refuses a call with no condition", async () => {
  using h = harness({});
  await assertRejects(
    () =>
      m.executionSet.execute(
        m.executionSet.arguments.parse({ targets: ["hook"] }),
        h.context,
      ),
    Error,
    "exactly one condition",
  );
  assertEquals(h.calls, []);
});

Deno.test("executionRemove clears a condition's targets", async () => {
  using h = harness({ "PUT /v2/actions/executions": {} });
  await m.executionRemove.execute(
    m.executionRemove.arguments.parse({ event: "user.human.added" }),
    h.context,
  );
  assertEquals(h.calls[0].body, { condition: COND, targets: [] });
  assertEquals(h.written()[0].data.action, "removed");
  assertEquals(h.forgotten, ["execution-event-user-human-added"]);
});

Deno.test("executionRemove with dryRun calls nothing", async () => {
  using h = harness({});
  await m.executionRemove.execute(
    m.executionRemove.arguments.parse({
      event: "user.human.added",
      dryRun: true,
    }),
    h.context,
  );
  assertEquals(h.calls, []);
  assertEquals(h.written()[0].data.action, "planned");
});

Deno.test("catalog stores services, methods and functions", async () => {
  using h = harness({
    "GET /v2/actions/executions/services": { services: ["s"] },
    "GET /v2/actions/executions/methods": { methods: ["m"] },
    "GET /v2/actions/executions/functions": { functions: ["f"] },
  });
  await m.catalog.execute({}, h.context);
  assertEquals(h.written().map((w) => [w.name, w.data.values]), [
    ["catalog-service", ["s"]],
    ["catalog-method", ["m"]],
    ["catalog-function", ["f"]],
  ]);
});

Deno.test("catalog fails when one part is refused, and writes nothing", async () => {
  using h = harness({
    "GET /v2/actions/executions/services": { services: ["s"] },
    "GET /v2/actions/executions/methods": fail(403),
  });
  await assertRejects(() => m.catalog.execute({}, h.context), Error, "403");
  assertEquals(h.written(), []);
});

const KEYS = "POST /v2/actions/targets/t1/publickeys/search";

Deno.test("keyList stores a target's public keys", async () => {
  using h = harness({
    [SEARCH]: found,
    [KEYS]: { publicKeys: [{ id: "k1", state: "PUBLIC_KEY_STATE_ACTIVE" }] },
  });
  await m.keyList.execute({ target: "hook" }, h.context);
  assertEquals(h.written()[0].data.state, "active");
  assertEquals(h.written()[0].data.keyId, "k1");
});

Deno.test("keyList fails on an unknown target", async () => {
  using h = harness({
    [SEARCH]: none,
    "GET /v2/actions/targets/x": fail(404),
  });
  await assertRejects(
    () => m.keyList.execute({ target: "x" }, h.context),
    Error,
    "no target",
  );
});

Deno.test("keyAdd adds a public key and stores its id", async () => {
  using h = harness({
    [SEARCH]: found,
    "POST /v2/actions/targets/t1/publickeys": { id: "k2" },
  });
  await m.keyAdd.execute({ target: "hook", publicKey: "PEM" }, h.context);
  assertEquals(h.written()[0].name, "public-key-t1-k2");
  assertEquals(h.writes().at(-1)!.body, { publicKey: "PEM" });
});

Deno.test("keyAdd fails when the key is refused", async () => {
  using h = harness({
    [SEARCH]: found,
    "POST /v2/actions/targets/t1/publickeys": fail(400, "bad key"),
  });
  await assertRejects(
    () => m.keyAdd.execute({ target: "hook", publicKey: "x" }, h.context),
    Error,
    "bad key",
  );
  assertEquals(h.written(), []);
});

Deno.test("keySetState deactivates a key", async () => {
  using h = harness({
    [SEARCH]: found,
    "POST /v2/actions/targets/t1/publickeys/k1/deactivate": {},
  });
  await m.keySetState.execute(
    { target: "hook", keyId: "k1", state: "inactive" },
    h.context,
  );
  assertEquals(h.written()[0].data.action, "deactivated");
});

Deno.test("keySetState fails on an API failure", async () => {
  using h = harness({
    [SEARCH]: found,
    "POST /v2/actions/targets/t1/publickeys/k1/activate": fail(404),
  });
  await assertRejects(
    () =>
      m.keySetState.execute(
        { target: "hook", keyId: "k1", state: "active" },
        h.context,
      ),
    Error,
    "HTTP 404",
  );
  assertEquals(h.written(), []);
});

Deno.test("keyRemove removes a key that belongs to the target", async () => {
  using h = harness({
    [SEARCH]: found,
    [KEYS]: { publicKeys: [{ id: "k1" }] },
    "DELETE /v2/actions/targets/t1/publickeys/k1": {},
  });
  await m.keyRemove.execute(
    m.keyRemove.arguments.parse({ target: "hook", keyId: "k1" }),
    h.context,
  );
  assertEquals(h.written()[0].data.action, "removed");
  assertEquals(h.forgotten, ["public-key-t1-k1"]);
});

Deno.test("keyRemove leaves a key the target does not have alone", async () => {
  using h = harness({ [SEARCH]: found, [KEYS]: { publicKeys: [] } });
  await m.keyRemove.execute(
    m.keyRemove.arguments.parse({ target: "hook", keyId: "k9" }),
    h.context,
  );
  assertEquals(h.written()[0].data.action, "unchanged");
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
  assert(h.logs().some((l) => l.startsWith("warning")));
});
