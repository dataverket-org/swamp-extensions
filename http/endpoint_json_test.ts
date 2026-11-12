import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  cut,
  isJsonContentType,
  jsonEqual,
  judgeJson,
  scanJson,
} from "./endpoint.ts";

// ---------------------------------------------------------------- units

Deno.test("scanJson: duplicates and depth, on valid and on broken text", () => {
  assertEquals(scanJson('{"a":1,"b":{"a":1}}'), {
    tooDeep: false,
    duplicate: null,
  });
  assertEquals(scanJson('{"a":1,"a":1}').duplicate, "/a");
  assertEquals(scanJson('{"a":[1,{"b/c":1,"b/c":2}]}').duplicate, "/a/1/b~1c");
  assertEquals(scanJson('{"a":"\\"","b":"a\\\\","a":1}').duplicate, "/a");
  assertEquals(scanJson('{"a":"x,\\"a\\":1"}').duplicate, null);
  assertEquals(scanJson('{"a":["a","a"],"b":"a"}').duplicate, null);
  assertEquals(
    scanJson('{"__proto__":1,"__proto__":2}').duplicate,
    "/__proto__",
  );
  assertEquals(scanJson("[[[]]]", 3).tooDeep, false);
  assertEquals(scanJson("[[[[]]]]", 3).tooDeep, true);
  assertEquals(scanJson('"[[[[[[[["', 3).tooDeep, false);
  for (
    const broken of [
      "",
      "}",
      "]]]",
      '{"a',
      '{"a\\',
      "{,,,}",
      '{"\\uZZZZ":1}',
      ",",
      '{"a":1}}}{"a":2,"a":3}',
    ]
  ) {
    scanJson(broken);
  }
});

Deno.test("judgeJson, jsonEqual, isJsonContentType, cut", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assertEquals(
    judgeJson(enc('{"a":1}'), "application/json", { a: 1 }, false),
    { matched: true, mismatches: [], count: 0 },
  );
  assertEquals(
    judgeJson(null, "application/json", { a: 1 }, true).mismatches[0].reason,
    "too-large",
  );
  assertEquals(
    judgeJson(enc("{}"), null, { a: 1 }, true).mismatches[0].reason,
    "content-type",
  );
  assert(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }));
  assert(!jsonEqual({ a: 1 }, { a: 1, b: 2 }));
  assert(!jsonEqual({ a: 1, b: 2 }, { a: 1 }));
  assert(!jsonEqual({ a: 1, b: 2 }, { a: 1, c: 2 }));
  assert(!jsonEqual([], {}));
  assert(!jsonEqual(null, {}));
  assert(!jsonEqual(0, false));
  assert(!jsonEqual("", null));
  assert(!jsonEqual({ constructor: Object }, {}));
  assert(isJsonContentType("application/json"));
  assert(isJsonContentType(" APPLICATION/JSON ;charset=utf-8"));
  assert(isJsonContentType("application/ld+json"));
  for (
    const no of [
      null,
      "",
      "json",
      "text/html",
      "application/json5",
      "application/json, text/html",
      "/+json",
      "a b/c+json",
    ]
  ) {
    assert(!isJsonContentType(no), String(no));
  }
  assertEquals(cut("abc", 3), "abc");
  assertEquals(cut("abcd", 3), "abc... (1 more characters)");
  assertEquals(cut("ab\u{1F600}", 3), "ab... (2 more characters)");
});
