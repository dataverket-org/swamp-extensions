import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import {
  __setExec,
  type CommandResult,
  composeArgs,
  type Context,
  extension,
  parsePs,
  ready,
} from "./compose.ts";

const psLine = (service: string, state: string, health = "") =>
  JSON.stringify({
    Name: `p-${service}-1`,
    Service: service,
    Status: state === "running" ? "Up 3 seconds" : "Exited (0)",
    State: state,
    Health: health,
  });
Deno.test("argv carries the file, project directory and profiles", () => {
  assertEquals(
    composeArgs({ composeFile: "c.yaml", profiles: ["a", "b"] }, "/d", ["ps"]),
    [
      "compose",
      "-f",
      "c.yaml",
      "--project-directory",
      "/d",
      "--profile",
      "a",
      "--profile",
      "b",
      "ps",
    ],
  );
});

Deno.test("ready means running, and healthy where there is a healthcheck", () => {
  const [up, healthy, starting, exited] = parsePs([
    psLine("a", "running"),
    psLine("b", "running", "healthy"),
    psLine("c", "running", "starting"),
    psLine("d", "exited"),
  ].join("\n"));
  assertEquals([up, healthy, starting, exited].map(ready), [
    true,
    true,
    false,
    false,
  ]);
  assertEquals(ready(undefined), false);
});

Deno.test("ps is parsed as one object per line or as one array", () => {
  const lines = [psLine("a", "running", "healthy"), psLine("b", "exited")];
  const expected = parsePs(lines.join("\n"));
  assertEquals(expected.map((s) => s.service), ["a", "b"]);
  assertEquals(parsePs(`[${lines.join(",")}]`), expected);
  assertEquals(parsePs(""), []);
  assertEquals(parsePs("[]\n"), []);
});

// ───── the methods, through createModelTestContext with a stub exec ─────

const { ensure, teardown } = extension.methods[0];

/** A stub docker: each call takes the next answer; a call past them fails. */
function stubExec(answers: CommandResult[]) {
  const calls: string[][] = [];
  const restore = __setExec((args) => {
    calls.push(args);
    const a = answers.shift();
    if (!a) return Promise.reject(new Error(`no answer for ${args.join(" ")}`));
    return Promise.resolve(a);
  });
  return { calls, restore };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

function harness() {
  const t = createModelTestContext({
    globalArgs: { composeFile: "compose.yaml", profiles: [] as string[] },
    repoDir: "/repo",
  });
  return { ...t, ctx: t.context as unknown as Context };
}

Deno.test("ensure starts only the services not ready and writes their state", async () => {
  const s = stubExec([
    ok(
      [psLine("db", "running", "healthy"), psLine("web", "exited")].join("\n"),
    ),
    ok(),
    ok(
      [psLine("db", "running", "healthy"), psLine("web", "running")].join("\n"),
    ),
  ]);
  try {
    const h = harness();
    await ensure.execute({ services: ["db", "web"] }, h.ctx);
    assertEquals(s.calls[1].slice(-4), ["up", "-d", "--wait", "web"]);
    const [w] = h.getWrittenResources();
    assertEquals([w.specName, w.name], ["state", "current"]);
    assertEquals(
      (w.data.services as { status: string }[]).map((x) => x.status),
      ["Up 3 seconds", "Up 3 seconds"],
    );
    assertEquals(
      h.getLogs().some((l) => l.message.startsWith("Starting")),
      true,
    );
  } finally {
    s.restore();
  }
});

Deno.test("ensure fails when docker compose up fails, and writes nothing", async () => {
  const s = stubExec([
    ok(psLine("web", "exited")),
    { code: 1, stdout: "", stderr: "port is already allocated\n" },
  ]);
  try {
    const h = harness();
    await assertRejects(
      () => ensure.execute({ services: ["web"] }, h.ctx),
      Error,
      "docker compose up -d --wait web failed (exit 1): port is already allocated",
    );
    assertEquals(h.getWrittenResources(), []);
  } finally {
    s.restore();
  }
});

Deno.test("teardown runs down with orphans and volumes and writes an empty state", async () => {
  const s = stubExec([ok()]);
  try {
    const h = harness();
    await teardown.execute({ volumes: true }, h.ctx);
    assertEquals(s.calls[0].slice(-3), [
      "down",
      "--remove-orphans",
      "--volumes",
    ]);
    const [w] = h.getWrittenResources();
    assertEquals([w.specName, w.name, w.data.services], [
      "state",
      "current",
      [],
    ]);
  } finally {
    s.restore();
  }
});

Deno.test("teardown fails when docker compose down fails, and writes nothing", async () => {
  const s = stubExec([{ code: 1, stdout: "", stderr: "no such file" }]);
  try {
    const h = harness();
    await assertRejects(
      () => teardown.execute({ volumes: false }, h.ctx),
      Error,
      "docker compose down --remove-orphans failed (exit 1): no such file",
    );
    assertEquals(h.getWrittenResources(), []);
  } finally {
    s.restore();
  }
});
