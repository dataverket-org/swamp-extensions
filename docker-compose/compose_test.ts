import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  __setExec,
  composeArgs,
  type Context,
  extension,
  parsePs,
  ready,
} from "./compose.ts";

const { ensure, teardown } = extension.methods[0];

const psLine = (service: string, state: string, health = "") =>
  JSON.stringify({
    Name: `p-${service}-1`,
    Service: service,
    Status: state === "running" ? "Up 3 seconds" : "Exited (0)",
    State: state,
    Health: health,
  });

function context() {
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const ctx: Context = {
    globalArgs: { composeFile: "compose.yaml", profiles: ["e2e"] },
    repoDir: "/repo",
    logger: { info: () => {} },
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { ctx, written };
}

/** A fake docker: `ps` answers in turn, everything else succeeds. */
function fake(psAnswers: string[][]) {
  const calls: string[][] = [];
  const restore = __setExec((args) => {
    calls.push(args);
    const stdout = args.includes("ps")
      ? (psAnswers.shift() ?? []).join("\n")
      : "";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  });
  return { calls, restore };
}

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

Deno.test("ensure starts nothing when every service is ready", async () => {
  const f = fake([[psLine("postgres", "running", "healthy")]]);
  try {
    const { ctx, written } = context();
    await ensure.execute({ services: ["postgres"] }, ctx);
    assertEquals(f.calls.some((a) => a.includes("up")), false);
    assertEquals(written[0].spec, "state");
    assertEquals(written[0].name, "current");
  } finally {
    f.restore();
  }
});

Deno.test("ensure starts only the services that are not ready", async () => {
  const f = fake([
    [
      psLine("postgres", "running", "healthy"),
      psLine("ldap", "running", "starting"),
    ],
    [
      psLine("postgres", "running", "healthy"),
      psLine("ldap", "running", "healthy"),
    ],
  ]);
  try {
    const { ctx, written } = context();
    await ensure.execute({ services: ["postgres", "ldap", "absent"] }, ctx);
    const up = f.calls.find((a) => a.includes("up"))!;
    assertEquals(up.slice(up.indexOf("up")), [
      "up",
      "-d",
      "--wait",
      "ldap",
      "absent",
    ]);
    assertEquals(
      (written[0].data.services as { health?: string }[]).map((s) => s.health),
      ["healthy", "healthy"],
    );
  } finally {
    f.restore();
  }
});

Deno.test("teardown removes orphans and volumes by default", async () => {
  const f = fake([]);
  try {
    const { ctx, written } = context();
    await teardown.execute({ volumes: true }, ctx);
    await teardown.execute({ volumes: false }, ctx);
    const downs = f.calls.map((a) => a.slice(a.indexOf("down")));
    assertEquals(downs, [["down", "--remove-orphans", "--volumes"], [
      "down",
      "--remove-orphans",
    ]]);
    assertEquals(written[0].data.services, []);
  } finally {
    f.restore();
  }
});

Deno.test("a failing compose throws with its stderr and writes nothing", async () => {
  const restore = __setExec(() =>
    Promise.resolve({ code: 1, stdout: "", stderr: "no such service: x" })
  );
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      teardown.execute({ volumes: true }, ctx)
    );
    assertStringIncludes(
      String(err),
      "docker compose down --remove-orphans --volumes failed (exit 1): no such service: x",
    );
    assertEquals(written.length, 0);
  } finally {
    restore();
  }
});
