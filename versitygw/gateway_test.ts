import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { model } from "./gateway.ts";
import {
  globalArgs,
  installFetch,
  keyFile,
  makeContext,
  ROOT_ACCESS,
  ROOT_SECRET,
  SECRET_MARK,
  type Written,
} from "./test_support.ts";

/** Run `fn` with a key file and the recorded gateway in place. */
async function withGateway(
  fn: (g: ReturnType<typeof globalArgs>) => Promise<void>,
): Promise<void> {
  const file = keyFile();
  const fake = installFetch();
  try {
    await fn(globalArgs({ rootKeyFile: file.path }));
  } finally {
    fake.restore();
    file.cleanup();
  }
}

/** Nothing secret, and not the root access key, in anything a run left. */
function assertNothingLeaked(written: Written[], logs: string[]): void {
  const all = JSON.stringify(written) + logs.join("\n");
  for (const value of [SECRET_MARK, ROOT_SECRET, ROOT_ACCESS]) {
    assertEquals(all.includes(value), false, `${value} leaked`);
  }
}

Deno.test("inventory writes every record, tagged with one id", async () => {
  await withGateway(async (g) => {
    const { context, written, logs } = makeContext(g);
    await model.methods.inventory.execute({}, context);
    const bySpec = (spec: string) => written.filter((w) => w.spec === spec);
    assertEquals(bySpec("health").length, 1);
    assertEquals(bySpec("account").map((w) => w.name), [
      "account-cnpg-forgejo",
      "account-idle",
      "account-ops",
      "account-restic-zitadel",
    ]);
    assertEquals(bySpec("bucket").length, 6);
    assertEquals(bySpec("bucketSettings").length, 6);
    const [summary] = bySpec("inventory");
    assertEquals(summary.data.accounts, 4);
    const ids = new Set(written.map((w) => w.tags.inventory));
    assertEquals([...ids], [summary.data.inventoryId]);
    assertNothingLeaked(written, logs);
  });
});

Deno.test("inventory twice produces identical records", async () => {
  await withGateway(async (g) => {
    const first = makeContext(g);
    const second = makeContext(g);
    await model.methods.inventory.execute({}, first.context);
    await model.methods.inventory.execute({}, second.context);
    // Only the inventory's own id and the health latency may differ.
    const stable = (written: Written[]) =>
      written.filter((w) => w.spec !== "inventory" && w.spec !== "health")
        .map((w) => ({ spec: w.spec, name: w.name, data: w.data }));
    assertEquals(stable(first.written), stable(second.written));
  });
});

Deno.test("bucketSettings reads what each bucket has and nulls what it lacks", async () => {
  await withGateway(async (g) => {
    const { context, written } = makeContext(g);
    await model.methods.bucketSettings.execute(
      { buckets: ["shared-scratch", "locked"] },
      context,
    );
    const [shared, locked] = written.map((w) => w.data);
    assertEquals(shared.versioning, "Enabled");
    assertStringIncludes(String(shared.policy), '"Principal":"*"');
    assertEquals(shared.cors, null);
    assertEquals(shared.tags, null);
    assertEquals(locked.objectLock, { enabled: true });
    assertEquals((locked.acl as { owner: string }).owner, "<root>");
  });
});

Deno.test("health records a plain HTTP endpoint as reachable", async () => {
  await withGateway(async (g) => {
    const { context, written } = makeContext(g);
    await model.methods.health.execute({}, context);
    assertEquals(written[0].data.reachable, true);
    assertEquals(written[0].data.tls, "plain");
    assertEquals(written[0].data.status, 200);
  });
});

Deno.test("check finds every seeded problem in the throwaway gateway", async () => {
  await withGateway(async (g) => {
    const { context, written } = makeContext(g);
    await model.methods.inventory.execute({}, context);
    await model.methods.check.execute(
      {},
      context,
    );
    const result = written.at(-1)!;
    assertEquals(result.spec, "check");
    const found = (result.data.findings as { rule: string; subject: string }[])
      .map((f) => `${f.rule} ${f.subject}`);
    assertEquals(found, [
      "account-owns-nothing idle",
      "account-role idle",
      "account-role ops",
      "bucket-owner-missing orphaned",
      "bucket-owner-not-same-named locked",
      "bucket-owner-not-same-named shared-scratch",
      "bucket-public shared-scratch",
      "versioning-enabled locked",
      "versioning-enabled shared-scratch",
    ]);
    assertEquals(result.data.clean, false);
  });
});

Deno.test("check reads only the inventory it is given", async () => {
  await withGateway(async (g) => {
    const shared: Written[] = [];
    const first = makeContext(g, shared);
    await model.methods.inventory.execute({}, first.context);
    const firstId = shared.find((w) => w.spec === "inventory")!.data
      .inventoryId as string;
    // A later inventory in which the gateway has changed: no accounts at all.
    const fake = installFetch((line) =>
      line === "PATCH /list-users"
        ? {
          method: "PATCH",
          path: "/list-users",
          status: 200,
          contentType: "application/xml",
          body: "<ListUserAccountsResult></ListUserAccountsResult>",
        }
        : undefined
    );
    try {
      await model.methods.inventory.execute({}, first.context);
    } finally {
      fake.restore();
    }
    await model.methods.check.execute(
      {
        inventoryId: firstId,
        rules: ["account-role"],
        allowedRoles: ["user"],
        failOnFindings: false,
      },
      first.context,
    );
    const result = shared.at(-1)!;
    assertEquals(result.data.inventoryId, firstId);
    assertEquals((result.data.findings as unknown[]).length, 2);
  });
});
