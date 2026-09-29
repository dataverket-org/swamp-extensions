import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./user.ts";
import { HUMAN_USER, MACHINE_USER } from "./fixtures.ts";
import { installFake, line, makeContext } from "./test_support.ts";
import type { ApiCall } from "./api.ts";
import { fromBase64, toBase64 } from "./api.ts";

const SEARCH = "POST /v2/users";
const MACHINE_GET = `GET /v2/users/${MACHINE_USER.userId}`;
const HUMAN_GET = `GET /v2/users/${HUMAN_USER.userId}`;

/** A v2 search page. */
/** The one call that matches this `METHOD /path`, so an added lookup cannot shift an index. */
function callTo(fake: { calls: ApiCall[] }, want: string) {
  const found = fake.calls.find((call) => line(call) === want);
  if (!found) throw new Error(`no call to ${want}`);
  return found;
}

function users(rows: unknown[]) {
  return { result: rows, details: { totalResult: String(rows.length) } };
}

Deno.test("list narrows to one kind of user and stores each one", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? users([MACHINE_USER]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ type: "machine" }, context);
    const queries =
      (callTo(fake, SEARCH).body as { queries: unknown[] }).queries;
    assert(queries.some((q) => JSON.stringify(q).includes("TYPE_MACHINE")));
    assert(
      queries.some((q) => JSON.stringify(q).includes("organizationIdQuery")),
    );
    assertEquals(written[0].name, "user-svc-flux");
    assertEquals(written[0].data.type, "machine");
    assertEquals(written[0].data.accessTokenType, "bearer");
  } finally {
    fake.restore();
  }
});

Deno.test("ensureMachine leaves a machine user that already matches alone", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? users([MACHINE_USER]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.ensureMachine.execute({
      username: "svc-flux",
      name: "Flux",
      description: "reconciles the cluster",
      accessTokenType: "bearer",
    }, context);
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "PATCH"));
    assert(fake.calls.every((call) => line(call) !== "POST /v2/users/new"));
  } finally {
    fake.restore();
  }
});

Deno.test("ensureMachine refuses to converge a human user of that name", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? users([HUMAN_USER]) : undefined
  );
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.ensureMachine.execute({
          username: "kari",
          name: "Kari",
          description: undefined,
          accessTokenType: "bearer",
        }, context),
      Error,
      "not a machine user",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("ensureHuman creates a human and never sends a password", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([]);
    if (line(call) === "POST /v2/users/new") return { id: HUMAN_USER.userId };
    if (line(call) === HUMAN_GET) return { user: HUMAN_USER };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensureHuman.execute({
      username: "kari",
      email: "kari@dataverket.org",
      givenName: "Kari",
      familyName: "Nordmann",
      displayName: undefined,
      nickName: undefined,
      gender: undefined,
      preferredLanguage: "nb",
      phone: undefined,
      emailVerified: true,
    }, context);
    const created = callTo(fake, "POST /v2/users/new");
    const body = JSON.stringify(created.body);
    assert(!body.includes("password"));
    assert(body.includes('"isVerified":true'));
    assert(
      (created.body as { organizationId?: string }).organizationId !==
        undefined,
      "the v2 user service wants the organization in the body",
    );
    assertEquals(written[0].data.action, "created");
    assertEquals(written[0].data.type, "human");
  } finally {
    fake.restore();
  }
});

Deno.test("update sends only the fields it was given", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([MACHINE_USER]);
    if (line(call) === `PATCH /v2/users/${MACHINE_USER.userId}`) return {};
    if (line(call) === MACHINE_GET) return { user: MACHINE_USER };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.update.execute({
      user: "svc-flux",
      description: "reconciles prod",
      username: undefined,
      email: undefined,
      emailVerified: undefined,
      givenName: undefined,
      familyName: undefined,
      displayName: undefined,
      phone: undefined,
      name: undefined,
      accessTokenType: undefined,
    }, context);
    assertEquals(callTo(fake, `PATCH /v2/users/${MACHINE_USER.userId}`).body, {
      machine: { description: "reconciles prod" },
    });
    assertEquals(written[0].data.action, "updated");
  } finally {
    fake.restore();
  }
});

Deno.test("update with nothing to change calls nothing", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? users([MACHINE_USER]) : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.update.execute({
      user: "svc-flux",
      username: undefined,
      email: undefined,
      emailVerified: undefined,
      givenName: undefined,
      familyName: undefined,
      displayName: undefined,
      phone: undefined,
      name: undefined,
      description: undefined,
      accessTokenType: undefined,
    }, context);
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "PATCH"));
  } finally {
    fake.restore();
  }
});

Deno.test("setState unlocks a locked user rather than reactivating", async () => {
  const locked = { ...MACHINE_USER, state: "USER_STATE_LOCKED" };
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([locked]);
    if (line(call) === `POST /v2/users/${MACHINE_USER.userId}/unlock`) {
      return {};
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.setState.execute(
      { user: "svc-flux", state: "active" },
      context,
    );
    assertEquals(written[0].data.previousState, "locked");
    assertEquals(written[0].data.action, "reactivated");
  } finally {
    fake.restore();
  }
});

Deno.test("delete refuses the wrong username, reports a dry run, then deletes", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([MACHINE_USER]);
    if (line(call) === `DELETE /v2/users/${MACHINE_USER.userId}`) return {};
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.delete.execute(
          { user: "svc-flux", confirm: "svc-fluxx", dryRun: false },
          context,
        ),
      Error,
      "refusing to delete",
    );
    await model.methods.delete.execute(
      { user: "svc-flux", confirm: "svc-flux", dryRun: true },
      context,
    );
    assertEquals(written[0].data.deleted, false);
    assert(fake.calls.every((call) => call.method !== "DELETE"));
    await model.methods.delete.execute(
      { user: "svc-flux", confirm: "svc-flux", dryRun: false },
      context,
    );
    assertEquals(written[1].data.deleted, true);
  } finally {
    fake.restore();
  }
});

Deno.test("patCreate stores the token once, in the sensitive spec", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([MACHINE_USER]);
    if (line(call) === `POST /v2/users/${MACHINE_USER.userId}/pats`) {
      return { tokenId: "77", token: "pat-once" };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.patCreate.execute(
      { user: "svc-flux", expirationDate: "2027-01-01T00:00:00Z" },
      context,
    );
    assertEquals(written[0].spec, "user-credential");
    assertEquals(written[0].data.secret, "pat-once");
    assertEquals(written[0].data.kind, "pat");
  } finally {
    fake.restore();
  }
});

Deno.test("patRevoke does nothing for a token this user does not hold", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([MACHINE_USER]);
    if (line(call) === "POST /v2/users/pats/search") {
      return { result: [{ id: "77" }] };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.patRevoke.execute(
      { user: "svc-flux", tokenId: "88", dryRun: false },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("keyCreate decodes the key content Zitadel base64-encodes", async () => {
  const keyJson = '{"type":"serviceaccount","keyId":"7"}';
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([MACHINE_USER]);
    if (line(call) === `POST /v2/users/${MACHINE_USER.userId}/keys`) {
      return { keyId: "7", keyContent: toBase64(keyJson) };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.keyCreate.execute(
      {
        user: "svc-flux",
        expirationDate: "2027-01-01T00:00:00Z",
        publicKey: undefined,
      },
      context,
    );
    assertEquals(written[0].data.secret, keyJson);
    assertEquals(written[0].data.kind, "key");
  } finally {
    fake.restore();
  }
});

Deno.test("metadata is base64 on the way out and decoded on the way back", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([HUMAN_USER]);
    if (line(call) === `POST /v2/users/${HUMAN_USER.userId}/metadata`) {
      return {};
    }
    if (line(call) === `POST /v2/users/${HUMAN_USER.userId}/metadata/search`) {
      return { metadata: [{ key: "groups", value: toBase64("kube-admin") }] };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.metadataSet.execute(
      { user: "kari", key: "groups", value: "kube-admin" },
      context,
    );
    const body = callTo(fake, `POST /v2/users/${HUMAN_USER.userId}/metadata`)
      .body as { metadata: { value: string }[] };
    assertEquals(fromBase64(body.metadata[0].value), "kube-admin");
    await model.methods.metadataList.execute({ user: "kari" }, context);
    assertEquals(written[1].data.value, "kube-admin");
  } finally {
    fake.restore();
  }
});

Deno.test("passwordResetLinkCreate returns a code and refuses a machine user", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) {
      const body = call.body as {
        queries?: { userNameQuery: { userName: string } }[];
      };
      const name = body.queries?.[0]?.userNameQuery.userName;
      return users([name === "kari" ? HUMAN_USER : MACHINE_USER]);
    }
    if (line(call) === `POST /v2/users/${HUMAN_USER.userId}/password_reset`) {
      return { verificationCode: "reset-once" };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.passwordResetLinkCreate.execute(
      { user: "kari", delivery: "return", urlTemplate: undefined },
      context,
    );
    assertEquals(written[0].data.verificationCode, "reset-once");
    await assertRejects(
      () =>
        model.methods.passwordResetLinkCreate.execute(
          { user: "svc-flux", delivery: "return", urlTemplate: undefined },
          context,
        ),
      Error,
      "not a human user",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("authFactorList gathers second factors and passkeys together", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([HUMAN_USER]);
    if (
      line(call) ===
        `POST /v2/users/${HUMAN_USER.userId}/authentication_factors/_search`
    ) {
      return {
        result: [
          { state: "AUTH_FACTOR_STATE_READY", otp: {} },
          {
            state: "AUTH_FACTOR_STATE_READY",
            u2f: { id: "u1", name: "Yubikey" },
          },
        ],
      };
    }
    if (line(call) === `POST /v2/users/${HUMAN_USER.userId}/passkeys/_search`) {
      return {
        result: [{
          id: "p1",
          name: "Telefon",
          state: "AUTH_FACTOR_STATE_READY",
        }],
      };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.authFactorList.execute({ user: "kari" }, context);
    assertEquals(written.map((w) => w.data.type), ["totp", "u2f", "passkey"]);
    assertEquals(written[1].data.name, "Yubikey");
    assertEquals(written[2].data.state, "ready");
  } finally {
    fake.restore();
  }
});

Deno.test("removing a u2f key or a passkey needs the id that names it", async () => {
  const fake = installFake((call) =>
    line(call) === SEARCH ? users([HUMAN_USER]) : undefined
  );
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.authFactorRemove.execute(
          { user: "kari", type: "u2f", id: undefined, dryRun: false },
          context,
        ),
      Error,
      "needs its id",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("removing a factor the person does not have is a no-op", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([HUMAN_USER]);
    if (
      line(call) ===
        `POST /v2/users/${HUMAN_USER.userId}/authentication_factors/_search`
    ) return { result: [] };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.authFactorRemove.execute(
      { user: "kari", type: "totp", id: undefined, dryRun: false },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("removing a factor under dryRun verifies but does not call", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([HUMAN_USER]);
    if (
      line(call) ===
        `POST /v2/users/${HUMAN_USER.userId}/authentication_factors/_search`
    ) return { result: [{ state: "AUTH_FACTOR_STATE_READY", otp: {} }] };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.authFactorRemove.execute(
      { user: "kari", type: "totp", id: undefined, dryRun: true },
      context,
    );
    assertEquals(written[0].data.action, "planned");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("unlinking an identity provider checks the link belongs to the user", async () => {
  const fake = installFake((call) => {
    if (line(call) === SEARCH) return users([HUMAN_USER]);
    if (line(call) === `POST /v2/users/${HUMAN_USER.userId}/links/_search`) {
      return {
        result: [{ idpId: "idp1", userId: "kari@idp", userName: "kari" }],
      };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.idpLinkRemove.execute(
      {
        user: "kari",
        idpId: "idp1",
        externalUserId: "someone-else@idp",
        dryRun: false,
      },
      context,
    );
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});
