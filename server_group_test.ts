import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model, normalizeServerGroup } from "./server_group.ts";
import { idRows, SERVER_GROUP_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = SERVER_GROUP_SHOW.id;

Deno.test("normalizeServerGroup reads policy (new) or policies (old microversion)", () => {
  const g = normalizeServerGroup(SERVER_GROUP_SHOW);
  assertEquals(g.policy, "anti-affinity");
  assertEquals(g.members, ["55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8"]);
  assertEquals(g.rules, { max_server_per_host: "1" });
  const old = normalizeServerGroup({
    ...SERVER_GROUP_SHOW,
    policy: undefined,
    policies: ["affinity"],
  });
  assertEquals(old.policy, "affinity");
});

Deno.test("list and get store server groups under servergroup-<name>", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "server group list -c ID") return idRows(ID);
    if (
      l === `server group show ${ID}` || l === "server group show web-spread"
    ) return SERVER_GROUP_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    await model.methods.get.execute({ serverGroup: "web-spread" }, context);
    assertEquals(written.map((w) => w.name), [
      "servergroup-web-spread",
      "servergroup-web-spread",
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("create passes policy and rule, reuses an existing group", async () => {
  let created = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "server group show web-spread") {
      return created
        ? SERVER_GROUP_SHOW
        : notFound("server group", "web-spread");
    }
    if (
      l ===
        "server group create --policy anti-affinity --rule max_server_per_host=1 web-spread"
    ) {
      created = true;
      return SERVER_GROUP_SHOW;
    }
    if (l === `server group show ${ID}`) return SERVER_GROUP_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "web-spread",
      policy: "anti-affinity",
      maxServerPerHost: 1,
    }, context);
    await model.methods.create.execute({
      name: "web-spread",
      policy: "anti-affinity",
    }, context);
    assertEquals(fake.calls.length, 4);
    assertEquals(written.length, 2);
  } finally {
    fake.restore();
  }
});

Deno.test("delete removes by id and drops the resource", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "server group show web-spread") return SERVER_GROUP_SHOW;
    if (l === `server group delete ${ID}`) return "";
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ serverGroup: "web-spread" }, context);
    assertEquals(deleted, ["servergroup-web-spread"]);
  } finally {
    fake.restore();
  }
});
