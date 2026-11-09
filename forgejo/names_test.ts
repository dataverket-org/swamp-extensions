import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  dataName,
  legacyLabelName,
  legacyName,
  repoName,
  slug,
  writeRecord,
} from "./names.ts";

// dataverket-org/swamp-extensions#1: a data name is a directory name in a
// filesystem datastore, and Windows refuses ':' there, so the names must hold
// on every platform.
// deno-lint-ignore no-control-regex
const WINDOWS_UNSAFE = /[<>:"|?*\\/\x00-\x1f]|[. ]$/;

Deno.test("slug keeps a part to [A-Za-z0-9._-], without a leading or trailing dash or a trailing dot", () => {
  assertEquals(slug("tool"), "tool");
  assertEquals(slug("acme/tool"), "acme-tool");
  assertEquals(slug("release/*"), "release");
  assertEquals(slug("foo-bar"), "foo-bar");
  assertEquals(slug("bug fix"), "bug-fix");
  assertEquals(slug("v1.2."), "v1.2");
  assertEquals(slug(12), "12");
  const wild = slug('a<b>:c"d|e?f*g/h\\i. ');
  assertEquals(WINDOWS_UNSAFE.test(wild), false);
  assertEquals(wild, "a-b-c-d-e-f-g-h-i");
});

Deno.test("dataName joins the spec word and the parts with a dash, the shape github kept from upstream", () => {
  assertEquals(dataName("repo", "acme", "tool"), "repo-acme-tool");
  assertEquals(dataName("pull", "acme", "tool", 12), "pull-acme-tool-12");
  assertEquals(
    dataName("push-mirror", "acme", "tool", "remote_mirror_1"),
    "push-mirror-acme-tool-remote_mirror_1",
  );
  // parts carry dashes, so these two coincide, as release-a-b-c does upstream;
  // the record's attributes tell them apart and the audit reconciles by those
  assertEquals(
    dataName("repo", "acme", "corp-x"),
    dataName("repo", "acme-corp", "x"),
  );
  // a Forgejo full name is split, so it reads like owner and repo given apart;
  // without a slash (an id when the API gave no full name) it is one part
  assertEquals(repoName("repo", "acme/tool"), "repo-acme-tool");
  assertEquals(repoName("webhook", "acme/tool", 7), "webhook-acme-tool-7");
  assertEquals(repoName("runner", "acme", "r1"), "runner-acme-r1");
  assertEquals(repoName("repo", "4711"), "repo-4711");
  assertEquals(
    WINDOWS_UNSAFE.test(dataName("label", "acme", "org", "bug fix")),
    false,
  );
});

Deno.test("the pre-2026.11.09.1 names are what the old safeName copies produced", () => {
  assertEquals(legacyName("acme/tool"), "acme:tool");
  assertEquals(legacyName("acme/tool#12"), "acme:tool#12");
  assertEquals(
    legacyName("acme/tool:workitem:../x\0"),
    "acme:tool:workitem:_:x",
  );
  assertEquals(
    legacyLabelName("acme:org:label:bug fix"),
    "acme:org:label:bug:fix",
  );
  assertEquals(WINDOWS_UNSAFE.test(legacyName("acme/tool")), true);
});

function recordCtx(stored: Record<string, Record<string, unknown>>) {
  const writes: { spec: string; name: string }[] = [];
  const warnings: Record<string, unknown>[] = [];
  const ctx = {
    logger: {
      info() {},
      warning(_msg: string, props?: Record<string, unknown>) {
        warnings.push(props ?? {});
      },
    },
    writeResource(spec: string, name: string) {
      writes.push({ spec, name });
      stored[name] = { written: true };
      return Promise.resolve({ name });
    },
    readResource(name: string) {
      if (name.includes("\0")) throw new Error("os error 123");
      return Promise.resolve(stored[name] ?? null);
    },
  };
  return { ctx, writes, warnings };
}

Deno.test("writeRecord writes the portable name and says once that old data is left behind", async () => {
  const stored: Record<string, Record<string, unknown>> = {
    "acme:tool": { full_name: "acme/tool" },
  };
  const { ctx, writes, warnings } = recordCtx(stored);
  const h = await writeRecord(ctx, "repo", "repo-acme-tool", "acme:tool", {
    n: 1,
  });
  assertEquals(h.name, "repo-acme-tool");
  assertEquals(writes, [{ spec: "repo", name: "repo-acme-tool" }]);
  assertEquals(warnings, [{ legacy: "acme:tool", name: "repo-acme-tool" }]);
  // the old data is untouched, and the next write is quiet
  assertEquals(stored["acme:tool"], { full_name: "acme/tool" });
  await writeRecord(ctx, "repo", "repo-acme-tool", "acme:tool", { n: 2 });
  assertEquals(warnings.length, 1);
});

Deno.test("writeRecord is quiet without old data, with an unchanged name, without readResource, and when the old name cannot be read", async () => {
  const fresh = recordCtx({});
  await writeRecord(fresh.ctx, "repo", "repo-acme-tool", "acme:tool", {});
  assertEquals(fresh.warnings, []);

  // org and user names did not change, so nothing is ever said about them
  const same = recordCtx({ acme: { name: "acme" } });
  await writeRecord(same.ctx, "org", "acme", "acme", {});
  assertEquals(same.warnings, []);

  const { readResource: _, ...bare } = recordCtx({}).ctx;
  const h = await writeRecord(
    bare,
    "repo",
    "repo-acme-tool",
    "acme:tool",
    {},
  );
  assertEquals(h.name, "repo-acme-tool");

  // on Windows the old name fails at the path; that is "no old data", not a failure
  const broken = recordCtx({});
  await writeRecord(broken.ctx, "repo", "repo-acme-tool", "acme:tool\0", {});
  assertEquals(broken.warnings, []);
});
