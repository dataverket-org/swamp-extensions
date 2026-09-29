import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  checks,
  friendlyState,
  instanceName,
  mapEnum,
  requireConfirm,
  sanitizeInstanceName,
  USER_TOKEN_TYPE,
  writeAll,
} from "./common.ts";
import { AppCredential, PasswordReset, UserCredential } from "./schema.ts";
import { fakeGlobalArgs, makeContext } from "./test_support.ts";

Deno.test("requireConfirm refuses when the name does not match", () => {
  const error = assertThrows(
    () => requireConfirm("fabrikk", "fabrik", "project name"),
    Error,
  );
  assert(error.message.includes("refusing to delete"));
  requireConfirm("fabrikk", "fabrikk", "project name");
});

Deno.test("friendlyState reduces a Zitadel enum to its tail", () => {
  assertEquals(friendlyState("PROJECT_STATE_ACTIVE"), "active");
  assertEquals(friendlyState(undefined), "unknown");
});

Deno.test("mapEnum lists what was allowed when the value is wrong", () => {
  const error = assertThrows(
    () => mapEnum(USER_TOKEN_TYPE, "opaque", "accessTokenType"),
    Error,
  );
  assert(error.message.includes("bearer, jwt"));
});

Deno.test("instance names are safe, and long ones stay unique", () => {
  assertEquals(instanceName("user", "Kari Nordmann"), "user-kari-nordmann");
  const long = "a".repeat(200);
  assertEquals(sanitizeInstanceName(long).length, 100);
  assert(sanitizeInstanceName(long) !== sanitizeInstanceName(long + "b"));
});

Deno.test("writeAll gives colliding instances distinct names", async () => {
  const { context, written } = makeContext();
  await writeAll(
    context,
    "user",
    "user",
    [{ username: "kari", id: "1" }, { username: "kari", id: "2" }],
    (user) => String(user.username),
  );
  assertEquals(written.length, 2);
  assert(written[0].name !== written[1].name);
});

Deno.test("the credential check wants exactly one source named", async () => {
  const both = await checks["credential-named"].execute({
    globalArgs: fakeGlobalArgs({ keyJsonFile: "/tmp/key.json" }),
  });
  assertEquals(both.pass, false);
  const neither = await checks["credential-named"].execute({
    globalArgs: fakeGlobalArgs({ keyJson: undefined }),
  });
  assertEquals(neither.pass, false);
  const one = await checks["credential-named"].execute({
    globalArgs: fakeGlobalArgs(),
  });
  assertEquals(one.pass, true);
});

Deno.test("reachable passes over an unresolved vault expression", async () => {
  const result = await checks.reachable.execute({
    globalArgs: fakeGlobalArgs({
      keyJson: "${{ vault.get('infra', 'zitadel/key_json') }}",
    }),
  });
  assertEquals(result.pass, true);
});

Deno.test("every secret a method emits is marked sensitive", () => {
  assertEquals(UserCredential.shape.secret.meta()?.sensitive, true);
  assertEquals(AppCredential.shape.clientSecret.meta()?.sensitive, true);
  assertEquals(PasswordReset.shape.verificationCode.meta()?.sensitive, true);
});
