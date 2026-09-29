import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { __internal, model } from "./action.ts";
import { installFake, line, makeContext } from "./test_support.ts";

const TARGET = {
  id: "t1",
  name: "hooks",
  endpoint: "https://hooks.example.org/zitadel",
  restWebhook: { interruptOnError: true },
  timeout: "10s",
};
const SEARCH = "POST /v2/actions/targets/search";
const GET = "GET /v2/actions/targets/t1";

function targets(rows: unknown[]) {
  return { targets: rows, pagination: { totalResult: String(rows.length) } };
}

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

Deno.test("list stores one resource per target, without a signing key", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? targets([TARGET]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    assertEquals(written[0].name, "target-hooks");
    assertEquals(written[0].data.style, "webhook");
    assertEquals(written[0].data.interruptOnError, true);
    assertEquals(Object.keys(written[0].data).includes("signingKey"), false);
  } finally {
    fake.restore();
  }
});

Deno.test("ensure returns the signing key once, on create", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return targets([]);
    if (line(call) === "POST /v2/actions/targets") {
      return { id: "t1", signingKey: "sign-once" };
    }
    if (line(call) === GET) return { target: TARGET };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensure.execute({
      name: "hooks",
      endpoint: "https://hooks.example.org/zitadel",
      style: "webhook",
      interruptOnError: true,
      timeout: "10s",
      payloadType: undefined,
      rotateSigningKey: false,
    }, context);
    const credential = written.find((w) => w.spec === "target-credential");
    assertEquals(credential?.data.signingKey, "sign-once");
    assertEquals(credential?.data.action, "created");
  } finally {
    fake.restore();
  }
});

Deno.test("ensure without rotateSigningKey mints no new key", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return targets([TARGET]);
    if (line(call) === "POST /v2/actions/targets/t1") return {};
    if (line(call) === GET) return { target: TARGET };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensure.execute({
      name: "hooks",
      endpoint: "https://hooks.example.org/zitadel",
      style: "webhook",
      interruptOnError: true,
      timeout: "10s",
      payloadType: undefined,
      rotateSigningKey: false,
    }, context);
    assertEquals(written.some((w) => w.spec === "target-credential"), false);
    const update = fake.calls.find((c) =>
      line(c) === "POST /v2/actions/targets/t1"
    );
    assertEquals(
      (update?.body as Record<string, unknown>).expirationSigningKey,
      undefined,
    );
  } finally {
    fake.restore();
  }
});

Deno.test("executionRemove clears a condition by setting no targets", async () => {
  const fake = installFake((call) =>
    line(call) === "PUT /v2/actions/executions" ? { setDate: "now" } : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.executionRemove.execute(
      {
        event: "user.human.added",
        requestService: undefined,
        requestMethod: undefined,
        responseService: undefined,
        responseMethod: undefined,
        eventGroup: undefined,
        allEvents: false,
        function: undefined,
        dryRun: false,
      },
      context,
    );
    const body = fake.calls[0].body as { targets: string[] };
    assertEquals(body.targets, []);
    assertEquals(written[0].data.deleted, true);
  } finally {
    fake.restore();
  }
});

Deno.test("executionRemove under dryRun calls nothing", async () => {
  const fake = installFake(() => undefined);
  const { context, written } = makeContext();
  try {
    await model.methods.executionRemove.execute(
      {
        event: "user.human.added",
        requestService: undefined,
        requestMethod: undefined,
        responseService: undefined,
        responseMethod: undefined,
        eventGroup: undefined,
        allEvents: false,
        function: undefined,
        dryRun: true,
      },
      context,
    );
    assertEquals(fake.calls.length, 0);
    assertEquals(written[0].data.action, "planned");
  } finally {
    fake.restore();
  }
});

Deno.test("delete refuses a confirm that is not the live name", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? targets([TARGET]) : undefined
  );
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.delete.execute(
          { target: "hooks", confirm: "hook", dryRun: false },
          context,
        ),
      Error,
      "refusing to delete",
    );
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("every destructive method is an action, not a delete", () => {
  assertEquals(model.methods.delete.kind, "action");
  assertEquals(model.methods.executionRemove.kind, "action");
  assertEquals(model.methods.keyRemove.kind, "action");
  assertEquals(model.methods.ensure.kind, "create");
});

Deno.test("a target endpoint Zitadel will not call says why, not just DeniedURL", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return targets([]);
    if (line(call) === "POST /v2/actions/targets") {
      return {
        status: 400,
        body: { message: "Errors.Target.DeniedURL (COMMAND-NcJUKo)" },
      };
    }
    return undefined;
  });
  const { context } = makeContext();
  try {
    const error = await assertRejects(
      () =>
        model.methods.ensure.execute({
          name: "hooks",
          endpoint: "https://hooks.invalid/zitadel",
          style: "webhook",
          interruptOnError: false,
          timeout: "10s",
          payloadType: undefined,
          rotateSigningKey: false,
        }, context),
      Error,
    );
    assert(error.message.includes("resolves the host first"), error.message);
    assert(error.message.includes("https://hooks.invalid/zitadel"));
  } finally {
    fake.restore();
  }
});
