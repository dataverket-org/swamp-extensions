import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { extension, normalizeColor } from "./labels.ts";
import { harness, writes } from "./stub_test.ts";

Deno.test("normalizeColor strips # and lowercases; anything else is refused", () => {
  assertEquals(normalizeColor("#EE0701"), "ee0701");
  assertEquals(normalizeColor("ee0701"), "ee0701");
  assertThrows(() => normalizeColor("red"), Error, "six hex");
  assertThrows(() => normalizeColor("#ee07"), Error);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const L = extension.methods[0];
const RL = "/api/v1/repos/acme/tool/labels";
const OL = "/api/v1/orgs/acme/labels";
const label = (id: number, name: string, color: string, description = "") => ({
  id,
  name,
  color,
  description,
  exclusive: false,
});

Deno.test("label_ensure creates a missing label, patches one that differs, keeps one that matches", async () => {
  const h = harness({
    [`GET ${RL}?limit=50&page=1`]: {
      status: 200,
      body: [label(1, "docs", "0075ca"), label(2, "bug", "ee0701", "old")],
    },
    [`POST ${RL}`]: { status: 201, body: label(3, "new", "000000") },
    [`PATCH ${RL}/2`]: {
      status: 200,
      body: label(2, "bug", "ee0701", "wrong"),
    },
  });
  await L.label_ensure.execute({
    owner: "acme",
    name: "tool",
    prune: false,
    labels: [
      { name: "docs", color: "#0075CA", description: "", exclusive: false },
      { name: "bug", color: "ee0701", description: "wrong", exclusive: false },
      { name: "new", color: "000000", description: "", exclusive: false },
    ],
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.method).sort(), ["PATCH", "POST"]);
  assertEquals(
    h.written().map((w) => [w.name, w.data.action]).sort(),
    [
      ["label-acme-tool-bug", "updated"],
      ["label-acme-tool-docs", "unchanged"],
      ["label-acme-tool-new", "created"],
    ],
  );
});

Deno.test("label_ensure refuses two labels of one name before any call", async () => {
  const h = harness({});
  await assertRejects(() =>
    L.label_ensure.execute({
      owner: "acme",
      prune: false,
      labels: [
        { name: "x", color: "000000", description: "", exclusive: false },
        { name: "x", color: "111111", description: "", exclusive: false },
      ],
    }, h.context)
  );
  assertEquals([h.calls, h.written()], [[], []]);
});

Deno.test("label_list records an organization's labels", async () => {
  const h = harness({
    [`GET ${OL}?limit=50&page=1`]: {
      status: 200,
      body: [label(1, "kind/bug", "ee0701")],
    },
  });
  await L.label_list.execute({ owner: "acme" }, h.context);
  assertEquals(h.written().map((w) => [w.name, w.data.scope, w.data.action]), [[
    "label-acme-org-kind-bug",
    "org",
    "listed",
  ]]);
});

Deno.test("label_list passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${OL}?limit=50&page=1`]: {
      status: 404,
      body: { message: "org not found" },
    },
  });
  await assertRejects(
    () => L.label_list.execute({ owner: "acme" }, h.context),
    Error,
    "HTTP 404: org not found",
  );
});
