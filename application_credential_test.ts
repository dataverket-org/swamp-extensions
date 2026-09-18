import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  model,
  normalizeApplicationCredential,
} from "./application_credential.ts";
import { APPCRED_CREATE, APPCRED_SHOW } from "./fixtures.ts";
import { fail, installFake, line, makeContext } from "./test_support.ts";

const ID = APPCRED_SHOW.ID;

Deno.test("normalizeApplicationCredential reads the capitalised identity columns", () => {
  const c = normalizeApplicationCredential(APPCRED_SHOW);
  assertEquals(c.id, ID);
  assertEquals(c.name, "swamp");
  assertEquals(c.roles, ["reader", "member"]);
  assertEquals(c.unrestricted, false);
  assertEquals(c.expiresAt, "");
  assertEquals(c.accessRules, "");
});

Deno.test("list uses the ID column and shows each credential", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "application credential list -c ID") return [{ ID }];
    if (l === `application credential show ${ID}`) return APPCRED_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    assertEquals(written.map((w) => w.name), ["appcred-swamp"]);
  } finally {
    fake.restore();
  }
});

Deno.test("create stores the one-time secret sensitively and never in the public resource", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "application credential show rotated") {
      return fail("No ApplicationCredential found for rotated");
    }
    if (
      l ===
        "application credential create --role reader --description ci --expiration 2027-01-01T00:00:00 --restricted rotated"
    ) {
      return APPCRED_CREATE;
    }
    if (l === `application credential show ${APPCRED_CREATE.ID}`) {
      return { ...APPCRED_SHOW, ID: APPCRED_CREATE.ID, Name: "rotated" };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "rotated",
      roles: ["reader"],
      description: "ci",
      expiration: "2027-01-01T00:00:00",
      unrestricted: false,
    }, context);
    assertEquals(written.map((w) => `${w.spec}:${w.name}`), [
      "applicationCredential:appcred-rotated",
      "secret:secret-rotated",
    ]);
    assertEquals(written[1].data.secret, "example-secret-shown-once");
    assert(!JSON.stringify(written[0].data).includes("example-secret"));
  } finally {
    fake.restore();
  }
});

Deno.test("create reuses an existing credential with a warning and no secret", async () => {
  const fake = installFake((
    args,
  ) => (line({ args, env: {} }) === "application credential show swamp"
    ? APPCRED_SHOW
    : undefined)
  );
  const { context, written, logs } = makeContext();
  try {
    await model.methods.create.execute(
      { name: "swamp", unrestricted: false },
      context,
    );
    assertEquals(written.length, 1);
    assert(
      logs.some((l) =>
        l.level === "warning" && l.message.includes("cannot be recovered")
      ),
    );
  } finally {
    fake.restore();
  }
});

Deno.test("create surfaces Keystone's refusal for restricted callers", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "application credential show x") {
      return fail("No ApplicationCredential found for x");
    }
    if (args[2] === "create") {
      return fail(
        "Forbidden: Application credentials cannot be created by an application credential. (HTTP 403)",
      );
    }
    return undefined;
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.create.execute(
          { name: "x", unrestricted: false },
          context,
        ),
      Error,
      "HTTP 403",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("delete drops both the credential and its secret resource", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "application credential show swamp") return APPCRED_SHOW;
    if (l === `application credential delete ${ID}`) return "";
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute(
      { applicationCredential: "swamp" },
      context,
    );
    assertEquals(deleted, ["appcred-swamp", "secret-swamp"]);
  } finally {
    fake.restore();
  }
});
