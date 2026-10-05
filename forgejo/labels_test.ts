import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  labelEnsure,
  labelsForIssues,
  listLabels,
  normalizeColor,
} from "./labels.ts";

interface Stored {
  id: number;
  name: string;
  color: string;
  description: string;
  exclusive: boolean;
}

/** A forge with org `acme` holding `orgLabels` and repo `acme/tool` holding `repoLabels`. */
function fakeApi(
  orgLabels: Stored[],
  repoLabels: Stored[],
  isOrg = true,
): { api: Caller; calls: ApiCall[]; org: Stored[]; repo: Stored[] } {
  const calls: ApiCall[] = [];
  let next = 100;
  const store = (path: string) =>
    path.startsWith("/api/v1/orgs/acme/labels")
      ? orgLabels
      : path.startsWith("/api/v1/repos/acme/tool/labels")
      ? repoLabels
      : undefined;
  const api: Caller = (c) => {
    calls.push(c);
    const [path, query = ""] = c.path.split("?");
    if (path === "/api/v1/orgs/acme") {
      return Promise.resolve(
        isOrg
          ? { status: 200, body: { username: "acme" } }
          : { status: 404, body: { message: "not an org" } },
      );
    }
    const list = store(path);
    if (!list) {
      return Promise.resolve({ status: 404, body: { message: "not found" } });
    }
    const idOf = () => Number(path.split("/").pop());
    const base = path.replace(/\/\d+$/, "");
    if (c.method === "GET" && path === base) {
      const page = Number(new URLSearchParams(query).get("page") ?? "1");
      return Promise.resolve({
        status: 200,
        body: list.slice((page - 1) * 50, page * 50) as unknown as Record<
          string,
          unknown
        >,
      });
    }
    if (c.method === "POST") {
      const b = c.body as Stored & { color: string };
      const l: Stored = {
        id: next++,
        name: b.name,
        color: b.color.replace(/^#/, ""),
        description: b.description ?? "",
        exclusive: b.exclusive ?? false,
      };
      list.push(l);
      return Promise.resolve({
        status: 201,
        body: l as unknown as Record<string, unknown>,
      });
    }
    if (c.method === "PATCH") {
      const l = list.find((x) => x.id === idOf());
      if (!l) return Promise.resolve({ status: 404, body: {} });
      const b = c.body as Partial<Stored>;
      Object.assign(l, b, { color: (b.color ?? l.color).replace(/^#/, "") });
      return Promise.resolve({
        status: 200,
        body: l as unknown as Record<string, unknown>,
      });
    }
    if (c.method === "DELETE") {
      const i = list.findIndex((x) => x.id === idOf());
      if (i >= 0) list.splice(i, 1);
      return Promise.resolve({ status: 204, body: {} });
    }
    return Promise.resolve({ status: 405, body: {} });
  };
  return { api, calls, org: orgLabels, repo: repoLabels };
}

const bug = {
  id: 1,
  name: "bug",
  color: "ee0701",
  description: "Something is not working",
  exclusive: false,
};

Deno.test("normalizeColor strips # and lowercases; anything else is refused", () => {
  assertEquals(normalizeColor("#EE0701"), "ee0701");
  assertEquals(normalizeColor("ee0701"), "ee0701");
  assertThrows(() => normalizeColor("red"), Error, "six hex");
  assertThrows(() => normalizeColor("#ee07"), Error);
});

Deno.test("a missing label is created on the org when no repository is named", async () => {
  const { api, calls, org } = fakeApi([], []);
  const out = await labelEnsure(api, {
    owner: "acme",
    labels: [{
      name: "llm-generated",
      color: "#6f42c1",
      description: "Written by a model",
      exclusive: false,
    }],
    prune: false,
  });
  assertEquals(out[0].action, "created");
  assertEquals(out[0].scope, "org");
  assertEquals(org[0].name, "llm-generated");
  const post = calls.find((c) => c.method === "POST");
  assertEquals(post?.path, "/api/v1/orgs/acme/labels");
  assertEquals(post?.body, {
    name: "llm-generated",
    color: "#6f42c1",
    description: "Written by a model",
    exclusive: false,
  });
});

Deno.test("a repository's labels are the repository's own path", async () => {
  const { api, calls } = fakeApi([], []);
  const out = await labelEnsure(api, {
    owner: "acme",
    name: "tool",
    labels: [{ ...bug, id: undefined } as unknown as typeof bug],
    prune: false,
  });
  assertEquals(out[0].scope, "repo");
  assertEquals(
    calls.find((c) => c.method === "POST")?.path,
    "/api/v1/repos/acme/tool/labels",
  );
});

Deno.test("a label that matches is left alone; color compares without # and case", async () => {
  const { api, calls } = fakeApi([{ ...bug }], []);
  const out = await labelEnsure(api, {
    owner: "acme",
    labels: [{
      name: "bug",
      color: "#EE0701",
      description: "Something is not working",
      exclusive: false,
    }],
    prune: false,
  });
  assertEquals(out[0].action, "unchanged");
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a label whose description or color differs is patched in place", async () => {
  const { api, org } = fakeApi([{ ...bug }], []);
  const out = await labelEnsure(api, {
    owner: "acme",
    labels: [{
      name: "bug",
      color: "d73a4a",
      description: "Broken",
      exclusive: false,
    }],
    prune: false,
  });
  assertEquals(out[0].action, "updated");
  assertEquals(org[0].color, "d73a4a");
  assertEquals(org[0].description, "Broken");
  assertEquals(org[0].id, 1);
});

Deno.test("nothing is deleted unless prune is set; with it, only labels not in the list", async () => {
  const old = {
    id: 2,
    name: "old",
    color: "cccccc",
    description: "",
    exclusive: false,
  };
  const a = fakeApi([{ ...bug }, { ...old }], []);
  await labelEnsure(a.api, {
    owner: "acme",
    labels: [{ ...bug }],
    prune: false,
  });
  assertEquals(a.org.length, 2);
  const b = fakeApi([{ ...bug }, { ...old }], []);
  const out = await labelEnsure(b.api, {
    owner: "acme",
    labels: [{ ...bug }],
    prune: true,
  });
  assertEquals(out.map((l) => `${l.name}:${l.action}`), [
    "bug:unchanged",
    "old:deleted",
  ]);
  assertEquals(b.org.map((l) => l.name), ["bug"]);
});

Deno.test("two labels of one name in a call are refused before any call", async () => {
  const { api, calls } = fakeApi([], []);
  await assertRejects(
    () =>
      labelEnsure(api, {
        owner: "acme",
        labels: [{ ...bug }, { ...bug }],
        prune: false,
      }),
    Error,
    "same name",
  );
  assertEquals(calls.length, 0);
});

Deno.test("an invalid color is refused before any call", async () => {
  const { api, calls } = fakeApi([], []);
  await assertRejects(() =>
    labelEnsure(api, {
      owner: "acme",
      labels: [{
        name: "x",
        color: "purple",
        description: "",
        exclusive: false,
      }],
      prune: false,
    })
  );
  assertEquals(calls.length, 0);
});

Deno.test("listLabels follows pages", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({
    id: i + 1,
    name: `l${i}`,
    color: "000000",
    description: "",
    exclusive: false,
  }));
  const { api, calls } = fakeApi(many, []);
  assertEquals((await listLabels(api, { owner: "acme" })).length, 70);
  assertEquals(calls.length, 2);
});

Deno.test("labels for issues are the repository's and, for an org, the org's", async () => {
  const llm = {
    id: 9,
    name: "llm-generated",
    color: "6f42c1",
    description: "",
    exclusive: false,
  };
  const o = fakeApi([llm], [{ ...bug }]);
  assertEquals(
    (await labelsForIssues(o.api, "acme", "tool")).map((l) => l.name),
    ["bug", "llm-generated"],
  );
  const u = fakeApi([llm], [{ ...bug }], false);
  assertEquals(
    (await labelsForIssues(u.api, "acme", "tool")).map((l) => l.name),
    ["bug"],
  );
});
