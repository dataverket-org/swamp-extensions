import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  blocking,
  END,
  extension,
  mergeSection,
  START,
} from "./work_item_sync.ts";
import { harness, writes } from "./stub_test.ts";

Deno.test("blocking keeps unresolved critical and high findings only", () => {
  assertEquals(
    blocking(
      {
        findings: [
          { id: "A-1", severity: "high", description: "x" },
          { id: "A-2", severity: "HIGH", description: "y", resolved: true },
          { id: "A-3", severity: "medium", description: "z" },
        ],
      },
      undefined,
      { findings: [{ id: "B-1", severity: "critical", summary: "w" }] },
    ),
    ["A-1: x", "B-1: w"],
  );
});
Deno.test("the section is replaced in place and text around it is kept", () => {
  const old = `intro\n\n${START}\nold\n${END}\noutro`;
  assertEquals(mergeSection(old, "NEW"), "intro\n\nNEW\noutro");
  assertEquals(
    mergeSection("a person's text", "NEW"),
    "a person's text\n\n---\n\nNEW",
  );
  assertEquals(mergeSection("", "NEW"), "NEW");
});

// ───── the method, through createModelTestContext with a stub client ─────

const sync = extension.methods[0].work_item_sync;
const I = "/api/v1/repos/acme/tool/issues";
const factory = (records: { name: string; attributes: unknown }[]) => ({
  readModelData: () => Promise.resolve(records),
});
const args = {
  owner: "acme",
  name: "tool",
  factory: "f",
  workItem: "WI-1",
  issue: 0,
};

Deno.test("work_item_sync files the work item's issue from the factory's records and records the link", async () => {
  const h = harness({
    [`POST ${I}`]: {
      status: 201,
      body: {
        number: 12,
        html_url: "https://forge.example.com/acme/tool/issues/12",
      },
    },
  }, {
    extra: factory([
      { name: "state-WI-1", attributes: { stageId: "plan", status: "active" } },
      {
        name: "artifact-WI-1-plan",
        attributes: { payload: { outcome: "Log every call. More." } },
      },
    ]),
  });
  await sync.execute(args, h.context);
  const post = writes(h.calls)[0].body as { title: string; body: string };
  assertEquals(post.title, "WI-1: Log every call.");
  assertEquals(post.body.startsWith(START), true);
  const w = h.written()[0];
  assertEquals([w.spec, w.name, w.data.issue, w.data.stage], [
    "workItemIssue",
    "work-item-acme-tool-WI-1",
    12,
    "plan",
  ]);
});

Deno.test("work_item_sync refuses a work item the factory does not have, filing nothing", async () => {
  const h = harness({}, { extra: factory([]) });
  await assertRejects(
    () => sync.execute(args, h.context),
    Error,
    "f has no work item WI-1; start it before syncing",
  );
  assertEquals([h.calls, h.written()], [[], []]);
});
