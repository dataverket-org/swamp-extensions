import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { HOSTILE } from "../lib/cli_fake.ts";
import { KubectlError } from "../lib/kubectl.ts";
import { type ExpectedKubectl, LOG_LINE, SAID } from "../lib/kubectl_fake.ts";
import {
  checkedEndpoint,
  type GlobalArgs,
  GlobalArgsSchema,
  model,
} from "./token_exchange.ts";
import {
  context,
  ends,
  type Fetched,
  json,
  jwt,
  NEVER,
  withCluster,
  withFetch,
  withFetchLimits,
} from "./test_support.ts";

const CLUSTER = { context: "kind-t" };
const base = {
  issuerUrl: "http://127.0.0.1:18090/issuer/",
  kubeContext: "kind-t",
  trustId: "11111111-1111-8111-8111-111111111111",
  requestAudience: "22222222-2222-8222-8222-222222222222",
};
const args = (over: Record<string, unknown> = {}): GlobalArgs =>
  GlobalArgsSchema.parse({ ...base, ...over });

const SA = "salmon-token-exchange-test";
const DISCOVERY =
  "http://127.0.0.1:18090/issuer/.well-known/openid-configuration";
const ENDPOINT = "http://127.0.0.1:18090/issuer/token";

// The two secrets of a run: what the cluster mints and what Salmon issues.
const SUBJECT_TOKEN = jwt({
  sub: `system:serviceaccount:default:${SA}`,
  aud: ["http://127.0.0.1:18090/issuer/"],
}, "c3ViamVjdC1zaWduYXR1cmU");
const ACCESS_TOKEN = jwt({
  sub: "trust/11111111",
  roles: ["users/Registry-Push"],
}, "YWNjZXNzLXNpZ25hdHVyZQ");
const SECRETS = [
  SUBJECT_TOKEN,
  ACCESS_TOKEN,
  SUBJECT_TOKEN.split(".")[2],
  ACCESS_TOKEN.split(".")[2],
];

function clean(text: string, what: string) {
  for (const s of SECRETS) assert(!text.includes(s), `${what} holds a token`);
}

// A scripted kubectl call; all but the get print text.
const k = (
  a: string[],
  answer: Partial<ExpectedKubectl> = {},
): ExpectedKubectl => ({ args: a, text: a[0] !== "get", ...answer });
const GET = ["get", "serviceaccount", SA, "-n", "default"];
const CREATE_SA = ["create", "serviceaccount", SA, "-n", "default"];
const TOKEN = [
  "create",
  "token",
  SA,
  "-n",
  "default",
  "--duration=10m",
  "--audience=http://127.0.0.1:18090/issuer/",
];
const found = k(GET, { out: { kind: "ServiceAccount" } });
const minted = k(TOKEN, { out: `${SUBJECT_TOKEN}\n` });

/** Salmon: discovery, then the token endpoint answered by `token`. */
function salmon(token: (req: Fetched) => Response | typeof NEVER) {
  return (req: Fetched): Response | typeof NEVER => {
    if (req.method === "GET" && req.url === DISCOVERY) {
      return json({ token_endpoint: ENDPOINT });
    }
    if (req.method === "POST" && req.url === ENDPOINT) return token(req);
    throw new Error(`fake fetch: unexpected ${req.method} ${req.url}`);
  };
}
const issued = () =>
  json({
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    expires_in: 3600,
    scope: "openid",
  });

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test("test: the token goes from kubectl to Salmon, and only its claims are recorded", async () => {
  const ctx = context(args());
  await withCluster({ ...CLUSTER, calls: [found, minted] }, async (f) => {
    await withFetch(salmon(issued), async (seen) => {
      const res = await model.methods.test.execute({}, ctx);
      assertEquals(res.dataHandles, [{ name: "result" }]);
      assertEquals(seen.length, 2);
      assertEquals(Object.fromEntries(new URLSearchParams(seen[1].body)), {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: SUBJECT_TOKEN,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: base.trustId,
        scope: "openid",
        audience: base.requestAudience,
      });
    });
    // No token is ever an argument or input of a command.
    clean(JSON.stringify(f.calls), "a command line");
  });
  assertEquals(ctx.writes.length, 1);
  const { testedAt, ...data } = ctx.writes[0].data;
  assert(typeof testedAt === "string");
  assertEquals([ctx.writes[0].spec, ctx.writes[0].name], ["result", "result"]);
  assertEquals(data, {
    passed: true,
    tokenEndpoint: ENDPOINT,
    trustId: base.trustId,
    subject: `system:serviceaccount:default:${SA}`,
    tokenType: "Bearer",
    issuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
    expiresIn: 3600,
    scope: "openid",
    tokenSubject: "trust/11111111",
    roles: ["users/Registry-Push"],
    httpStatus: 200,
    error: "",
  });
  clean(ctx.everything(), "the record or a log line");
});

Deno.test("test: a ServiceAccount that is not there is created, and one made meanwhile is fine", async () => {
  const missing = k(GET, { fail: SAID.notFound("serviceaccounts", SA) });
  for (
    const create of [
      k(CREATE_SA, { out: `serviceaccount/${SA} created\n` }),
      k(CREATE_SA, { fail: SAID.alreadyExists("serviceaccounts", SA) }),
    ]
  ) {
    const ctx = context(args());
    await withCluster(
      { ...CLUSTER, calls: [missing, create, minted] },
      () =>
        withFetch(salmon(issued), () => model.methods.test.execute({}, ctx)),
    );
    assertEquals(ctx.writes.length, 1);
    assert(ctx.logs.some((l) => l.startsWith("Creating service account")));
  }
});

Deno.test("test: kubeconfig, kubectlBinary, namespace, duration and audience reach kubectl as given", async () => {
  const g = args({
    kubeconfig: "/work/kubeconfig",
    kubectlBinary: "/opt/kubectl",
    namespace: "apps",
    serviceAccount: "orders",
    tokenDuration: "1h",
    audience: "https://salmon.example/issuer/",
  });
  const ctx = context(g);
  await withCluster({
    context: "kind-t",
    kubeconfig: "/work/kubeconfig",
    bin: "/opt/kubectl",
    calls: [
      {
        args: ["get", "serviceaccount", "orders", "-n", "apps"],
        out: {},
      },
      {
        text: true,
        args: [
          "create",
          "token",
          "orders",
          "-n",
          "apps",
          "--duration=1h",
          "--audience=https://salmon.example/issuer/",
        ],
        out: SUBJECT_TOKEN,
      },
    ],
  }, async (f) => {
    await withFetch(salmon(issued), () => model.methods.test.execute({}, ctx));
    assertEquals(f.calls[0].args.slice(0, 5), [
      "--kubeconfig",
      "/work/kubeconfig",
      "--context",
      "kind-t",
      "--request-timeout=30s",
    ]);
  });
  assertEquals(ctx.writes[0].data.subject, "system:serviceaccount:apps:orders");
});

Deno.test("test: without requestAudience no audience is sent, and missing claims are recorded empty", async () => {
  const ctx = context(args({ requestAudience: undefined }));
  await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
    await withFetch(
      salmon(() => json({ access_token: jwt({}) })),
      async (seen) => {
        await model.methods.test.execute({}, ctx);
        assert(!new URLSearchParams(seen[1].body).has("audience"));
      },
    );
  });
  assertEquals(ctx.writes[0].data.tokenSubject, "");
  assertEquals(ctx.writes[0].data.roles, []);
  assertEquals(ctx.writes[0].data.expiresIn, 0);
});

// ---------------------------------------------------------------------------
// Negative: kubectl
// ---------------------------------------------------------------------------

Deno.test("test: a refused, unauthorized or unreachable cluster is a named failure and nothing is created", async () => {
  for (
    const [fail, kind, says] of [
      [
        SAID.forbidden("get", "serviceaccounts", "default"),
        "forbidden",
        "is forbidden",
      ],
      [SAID.badToken, "unauthorized", "log in again"],
      [SAID.refused, "unreachable", "could not be reached"],
      [SAID.requestTimeout, "timeout", "no answer in time"],
      ['error: context "kind-t" does not exist\n', "other", "does not exist"],
    ] as const
  ) {
    const ctx = context(args());
    await withCluster(
      { ...CLUSTER, calls: [k(GET, { fail })] },
      async () => {
        const err = await withFetch(salmon(issued), (seen) =>
          assertRejects(
            () => model.methods.test.execute({}, ctx),
            KubectlError,
          ).finally(() => assertEquals(seen.length, 1)));
        assertEquals(err.kind, kind);
        assertStringIncludes(err.message, says);
        assertStringIncludes(err.message, "kubectl get serviceaccount");
        // The five client-go log lines are not what the message holds.
        assert(!err.message.includes("memcache.go"), err.message);
      },
    );
    assertEquals(ctx.writes, []);
  }
});

Deno.test("test: a failed create of the ServiceAccount or the token is named, and no exchange is tried", async () => {
  const missing = k(GET, { fail: SAID.notFound("serviceaccounts", SA) });
  for (
    const calls of [
      [
        missing,
        k(CREATE_SA, {
          fail: SAID.forbidden("create", "serviceaccounts", "default"),
        }),
      ],
      [
        found,
        k(TOKEN, {
          fail: SAID.forbidden("create", "serviceaccounts", "default"),
        }),
      ],
    ]
  ) {
    const ctx = context(args());
    await withCluster({ ...CLUSTER, calls }, async () => {
      await withFetch(salmon(issued), async (seen) => {
        const err = await assertRejects(
          () => model.methods.test.execute({}, ctx),
          KubectlError,
        );
        assertEquals(err.kind, "forbidden");
        assertEquals(seen.length, 1);
      });
    });
    assertEquals(ctx.writes, []);
  }
});

Deno.test("test: a token kubectl prints beside an error never reaches the error", async () => {
  const ctx = context(args());
  await withCluster({
    ...CLUSTER,
    calls: [
      found,
      k(TOKEN, {
        fail: LOG_LINE +
          `error: failed to create token: tried ${SUBJECT_TOKEN} with Authorization: Bearer ${SUBJECT_TOKEN}\n`,
        stdout: `${SUBJECT_TOKEN}\n`,
        code: 1,
      }),
    ],
  }, async () => {
    const err = await withFetch(
      salmon(issued),
      () =>
        assertRejects(() => model.methods.test.execute({}, ctx), KubectlError),
    );
    assertStringIncludes(err.message, "kubectl create token");
    assertStringIncludes(err.message, "failed to create token");
    clean(err.message, "the error");
    clean(err.stderr, "the error's stderr");
  });
  clean(ctx.everything(), "the record or a log line");
  assertEquals(ctx.writes, []);
});

Deno.test("test: a kubectl that prints no token, hangs or is not there", async () => {
  for (
    const [answer, says] of [
      [{ out: "\n" }, "printed no token"],
      [{ hang: true }, "no answer within 35 seconds; kubectl was stopped"],
      [{ notInstalled: true }, "kubectl is not on PATH"],
    ] as [Partial<ExpectedKubectl>, string][]
  ) {
    const ctx = context(args());
    await withCluster(
      { ...CLUSTER, calls: [found, k(TOKEN, answer)] },
      async () => {
        await withFetch(salmon(issued), async (seen) => {
          await assertRejects(
            () => model.methods.test.execute({}, ctx),
            Error,
            says,
          );
          assertEquals(seen.length, 1);
        });
      },
    );
    assertEquals(ctx.writes, []);
  }
});

Deno.test("test: a cancelled run stops at kubectl and is said so", async () => {
  const stop = new AbortController();
  const ctx = context(args(), stop.signal);
  await withCluster({
    ...CLUSTER,
    calls: [k(GET, { hang: "until-cancelled" })],
  }, async () => {
    await withFetch(salmon(issued), async () => {
      const run = model.methods.test.execute({}, ctx);
      await new Promise((r) => setTimeout(r, 0));
      stop.abort();
      const err = await assertRejects(() => run, KubectlError);
      assertEquals(err.kind, "cancelled");
    });
  });
  assertEquals(ctx.writes, []);
});

Deno.test("test: a namespace or serviceAccount that is not a Kubernetes name is refused before anything runs", async () => {
  await withCluster({ ...CLUSTER }, async (f) => {
    await withFetch(salmon(issued), async (seen) => {
      for (const bad of HOSTILE) {
        await assertRejects(
          () =>
            model.methods.test.execute(
              {},
              context({ ...args(), namespace: bad }),
            ),
          Error,
          "is not a Kubernetes namespace name",
        );
        await assertRejects(
          () =>
            model.methods.test.execute(
              {},
              context({ ...args(), serviceAccount: bad }),
            ),
          Error,
          "is not a Kubernetes object name",
        );
        // And the schema refuses both before a definition is stored.
        for (const key of ["namespace", "serviceAccount"]) {
          assert(
            !GlobalArgsSchema.safeParse({ ...base, [key]: bad }).success,
            `${key}=${JSON.stringify(bad)}`,
          );
        }
      }
      assertEquals(seen, []);
    });
    assertEquals(f.calls, []);
  });
});

Deno.test("test: an audience or duration that would become a second argument or a runner flag is refused", async () => {
  for (
    const over of [
      { audience: "a\n--context=other" },
      { tokenDuration: "10m\n-A" },
    ]
  ) {
    await withCluster({ ...CLUSTER, calls: [found] }, async (f) => {
      await withFetch(salmon(issued), () =>
        assertRejects(
          () => model.methods.test.execute({}, context(args(over))),
          Error,
          "must not hold a line break",
        ));
      assertEquals(f.calls.length, 1);
    });
  }
  // One that starts like a flag stays the value of --audience=.
  const ctx = context(args({ audience: "--context=other" }));
  await withCluster(
    {
      ...CLUSTER,
      calls: [
        found,
        k([...TOKEN.slice(0, 6), "--audience=--context=other"], {
          out: SUBJECT_TOKEN,
        }),
      ],
    },
    () => withFetch(salmon(issued), () => model.methods.test.execute({}, ctx)),
  );
});

// ---------------------------------------------------------------------------
// Negative: Salmon
// ---------------------------------------------------------------------------

Deno.test("test: Salmon's refusal is the error, with its code and description, and is recorded as not passed", async () => {
  const ctx = context(args());
  await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
    const err = await withFetch(
      salmon(() =>
        json({
          error: "invalid_target",
          error_description: "the trust has no grant at this app",
        }, 400)
      ),
      () => assertRejects(() => model.methods.test.execute({}, ctx), Error),
    );
    assertEquals(
      err.message,
      `token exchange failed (HTTP 400) for trust ${base.trustId}: invalid_target: the trust has no grant at this app`,
    );
  });
  // A refused exchange is a result: recorded as not passed, with the reason.
  assertEquals(ctx.writes.length, 1);
  const { testedAt, ...data } = ctx.writes[0].data;
  assert(typeof testedAt === "string");
  assertEquals(data, {
    passed: false,
    tokenEndpoint: ENDPOINT,
    trustId: base.trustId,
    subject: `system:serviceaccount:default:${SA}`,
    tokenType: "",
    issuedTokenType: "",
    expiresIn: 0,
    scope: "",
    tokenSubject: "",
    roles: [],
    httpStatus: 400,
    error: "invalid_target: the trust has no grant at this app",
  });
});

Deno.test("test: an answer that repeats the subject token, or holds an issued one, never reaches the error", async () => {
  const opaque = "opaque-subject-token-0123456789";
  for (
    const [token, answer] of [
      [SUBJECT_TOKEN, () =>
        json({
          error: "invalid_grant",
          error_description: `subject_token ${SUBJECT_TOKEN} is expired`,
        }, 400)],
      [
        SUBJECT_TOKEN,
        () =>
          new Response(`<h1>500</h1> could not verify ${SUBJECT_TOKEN}`, {
            status: 500,
          }),
      ],
      [
        SUBJECT_TOKEN,
        () => json({ id_token: ACCESS_TOKEN, refresh_token: "r3fr3sh-value" }),
      ],
      [SUBJECT_TOKEN, () => json({ access_token: 7, token: ACCESS_TOKEN })],
      // A token that is not shaped like a JWT is still blanked word for word.
      [
        opaque,
        () => new Response(`cannot parse ${opaque} as a JWT`, { status: 400 }),
      ],
    ] as [string, () => Response][]
  ) {
    const ctx = context(args());
    await withCluster({
      ...CLUSTER,
      calls: [found, k(TOKEN, { out: token })],
    }, async () => {
      const err = await withFetch(
        salmon(answer),
        () => assertRejects(() => model.methods.test.execute({}, ctx), Error),
      );
      assertStringIncludes(err.message, "token exchange failed (HTTP ");
      clean(err.message, "the error");
      assert(!err.message.includes(opaque), err.message);
      assert(!err.message.includes("r3fr3sh-value"), err.message);
    });
    clean(ctx.everything(), "the record or a log line");
    assert(!ctx.everything().includes(opaque));
    assert(!ctx.everything().includes("r3fr3sh-value"));
    assertEquals(ctx.writes.map((w) => w.data.passed), [false]);
    assert(String(ctx.writes[0].data.error).length > 0);
  }
});

Deno.test("test: an access_token that is not a JWT is said so, without its text", async () => {
  for (
    const token of [
      "opaque-access-token-value",
      "a.b",
      `x.${btoa("not json but secret-looking-claims")}.y`,
      `x.${btoa('"a string"')}.y`,
    ]
  ) {
    const ctx = context(args());
    await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
      const err = await withFetch(
        salmon(() => json({ access_token: token })),
        () => assertRejects(() => model.methods.test.execute({}, ctx), Error),
      );
      assertEquals(err.message, "the access_token Salmon issued is not a JWT");
    });
    assertEquals(
      ctx.writes.map((w) => [w.data.passed, w.data.httpStatus, w.data.error]),
      [[false, 200, "the access_token Salmon issued is not a JWT"]],
    );
    assert(!ctx.everything().includes(token));
  }
});

Deno.test("test: a Salmon that is not there, or has no discovery document, is named before kubectl runs", async () => {
  await withCluster({ ...CLUSTER }, async (f) => {
    const gone = await withFetch(() => {
      throw new TypeError("error sending request: connection refused");
    }, () =>
      assertRejects(
        () => model.methods.test.execute({}, context(args())),
        Error,
      ));
    assertStringIncludes(gone.message, `not reachable at ${DISCOVERY}`);
    const missing = await withFetch(
      () => new Response("no", { status: 404 }),
      () =>
        assertRejects(
          () => model.methods.test.execute({}, context(args())),
          Error,
        ),
    );
    assertEquals(missing.message, `GET ${DISCOVERY} returned 404`);
    assertEquals(f.calls, []);
  });
});

Deno.test("the fake kubectl is strict: another cluster, a missing timeout, an unknown command or flag is refused", async () => {
  const { runKubectlText } = await import("../lib/kubectl.ts");
  const { runCli } = await import("../lib/cli.ts");
  await withCluster({ ...CLUSTER }, async () => {
    for (
      const [a, context] of [
        [["get", "serviceaccount", SA, "-n", "default"], "kind-other"],
        [["get", "serviceaccount", SA, "-n", "default"], "kind-t"],
        [["delete", "serviceaccount", SA, "-n", "default"], "kind-t"],
        [["create", "token", SA, "-n", "default", "--duration=10m"], "kind-t"],
        [
          ["create", "serviceaccount", SA, "-n", "default", "--save-config"],
          "kind-t",
        ],
        [["create", "serviceaccount", "--all", "-n", "default"], "kind-t"],
        [["create", "serviceaccount", SA, "-n", "-A"], "kind-t"],
      ] as [string[], string][]
    ) {
      await assertRejects(
        () => runKubectlText(a, { context }),
        Error,
        "fake kubectl:",
      );
    }
    await assertRejects(
      () => runCli("kubectl", ["--context", "kind-t", ...CREATE_SA]),
      Error,
      "fake kubectl:",
    );
  });
});

Deno.test("the pre-flight check runs the kubectl the definition names", async () => {
  const check = model.checks["kubectl-cli-available"];
  await withCluster({ ...CLUSTER, bin: "/opt/kubectl" }, async (f) => {
    assertEquals(
      await check.execute({
        globalArgs: args({ kubectlBinary: "/opt/kubectl" }),
      }),
      { pass: true },
    );
    assertEquals(f.calls.map((c) => [c.bin, ...c.args]), [
      ["/opt/kubectl", "version", "--client"],
    ]);
  });
  await withCluster({
    ...CLUSTER,
    calls: [{ args: ["version", "--client"], notInstalled: true }],
  }, async () => {
    const res = await check.execute({ globalArgs: args() });
    assertEquals(res.pass, false);
    assertStringIncludes(res.errors![0], "kubectl is not on PATH");
  });
});

Deno.test("an issuer URL with a user or password is refused by the schema, and again by the method", async () => {
  const planted = "http://admin:hunter2secret@127.0.0.1:18090/issuer";
  const parsed = GlobalArgsSchema.safeParse({ ...base, issuerUrl: planted });
  assert(!parsed.success);
  assertStringIncludes(
    JSON.stringify(parsed.error.issues),
    "must not hold a user or password",
  );
  assert(!JSON.stringify(parsed.error.issues).includes("hunter2secret"));
  // A definition that reached the method without the schema. Before the
  // refusal, the password went into --audience= of kubectl create token,
  // into a log line and into the record.
  const ctx = context({ ...args(), issuerUrl: planted });
  await withCluster({ ...CLUSTER }, async (f) => {
    await withFetch(
      () => json({}),
      async (seen) => {
        const err = await assertRejects(
          () => model.methods.test.execute({}, ctx),
          Error,
          "must not hold a user or password",
        );
        assert(!err.message.includes("hunter2secret"));
        assertEquals(seen, []);
      },
    );
    assertEquals(f.calls, []);
  });
  assertEquals([ctx.writes, ctx.logs], [[], []]);
});

Deno.test("test: a discovery document that is not one is named, without its text", async () => {
  for (
    const [body, says] of [
      [
        "<html>login eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln</html>",
        "did not return a discovery document (59 characters",
      ],
      ["null", "did not return a discovery document"],
      ["[1]", "did not return a discovery document"],
      ['"text"', "did not return a discovery document"],
      ["{}", "names no token_endpoint"],
      ['{"token_endpoint":7}', "names no token_endpoint"],
      ['{"token_endpoint":""}', "names no token_endpoint"],
      ['{"token_endpoint":"/issuer/token"}', "that is not a URL"],
      [
        '{"token_endpoint":"ftp://127.0.0.1/token"}',
        "must be an http or https URL",
      ],
      [
        '{"token_endpoint":"file:///etc/passwd"}',
        "must be an http or https URL",
      ],
      [
        '{"token_endpoint":"http://u:hunter2secret@127.0.0.1/token"}',
        "without a user or password",
      ],
    ]
  ) {
    const ctx = context(args());
    await withCluster({ ...CLUSTER }, async (f) => {
      const err = await withFetch(
        () => new Response(body),
        () => assertRejects(() => model.methods.test.execute({}, ctx), Error),
      );
      assertStringIncludes(err.message, says);
      assertStringIncludes(err.message, DISCOVERY);
      assert(!err.message.includes("\n"), err.message);
      assert(!/hunter2secret|eyJ|SyntaxError|Unexpected/.test(err.message));
      // The ServiceAccount token is not minted for an endpoint not trusted.
      assertEquals(f.calls, []);
    });
    assertEquals([ctx.writes, ctx.logs], [[], []]);
  }
});

Deno.test("the token endpoint need not share the issuer's origin", async () => {
  // Decided: RFC 8414 does not ask for it, and Salmon answers with the host
  // of its configured issuer (localhost) when asked on 127.0.0.1.
  const other = "https://localhost:18090/issuer/token";
  assertEquals(checkedEndpoint(other, DISCOVERY), other);
  const ctx = context(args());
  await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
    await withFetch((req) => {
      if (req.method === "GET") return json({ token_endpoint: other });
      assertEquals(req.url, other);
      return issued();
    }, () => model.methods.test.execute({}, ctx));
  });
  assertEquals(ctx.writes[0].data.tokenEndpoint, other);
});

Deno.test("test: an exchange that could not be sent is named with the endpoint, and is not a result", async () => {
  // A token that is not shaped like one, so only its name can blank it.
  const opaque = "opaque-subject-token-0123456789";
  const ctx = context(args());
  await withCluster({
    ...CLUSTER,
    calls: [found, k(TOKEN, { out: opaque })],
  }, async () => {
    const err = await withFetch(
      salmon(() => {
        throw new TypeError(`error sending request with ${opaque}`);
      }),
      () => assertRejects(() => model.methods.test.execute({}, ctx), Error),
    );
    assertStringIncludes(
      err.message,
      `the token exchange could not be sent to ${ENDPOINT}: error sending request with [redacted]`,
    );
    assert(!err.message.includes(opaque));
  });
  assertEquals(ctx.writes, []);
});

Deno.test("test: an answer of JSON null, a list or nothing is a failed exchange, not a TypeError", async () => {
  for (
    const [body, reason] of [
      ["null", "null"],
      ["[]", "[]"],
      ["", "(an empty answer)"],
    ]
  ) {
    const ctx = context(args());
    await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
      const err = await withFetch(
        salmon(() => new Response(body)),
        () => assertRejects(() => model.methods.test.execute({}, ctx), Error),
      );
      assertEquals(
        err.message,
        `token exchange failed (HTTP 200) for trust ${base.trustId}: ${reason}`,
      );
    });
    assertEquals(
      ctx.writes.map((w) => [w.data.passed, w.data.error]),
      [[false, reason]],
    );
  }
});

Deno.test("test: a Salmon that accepts a request and never answers cannot hold the method", async () => {
  // Discovery never answers: nothing is asked of the cluster.
  await withCluster({ ...CLUSTER }, async (f) => {
    const err = await withFetchLimits(
      20,
      () =>
        withFetch(() => NEVER, () =>
          ends(
            assertRejects(
              () => model.methods.test.execute({}, context(args())),
              Error,
            ),
          )),
    );
    assertStringIncludes(
      err.message,
      `not reachable at ${DISCOVERY} (start a @dataverket/salmon/stack): no answer within 0.02 seconds`,
    );
    assertEquals(f.calls, []);
  });
  // The exchange never answers: named, and not recorded as a result.
  const ctx = context(args());
  await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
    const err = await withFetchLimits(
      20,
      () =>
        withFetch(salmon(() => NEVER), () =>
          ends(
            assertRejects(() => model.methods.test.execute({}, ctx), Error),
          )),
    );
    assertStringIncludes(
      err.message,
      `could not be sent to ${ENDPOINT}: no answer within 0.02 seconds`,
    );
  });
  assertEquals(ctx.writes, []);
});

Deno.test("test: a run cancelled while Salmon is asked ends at once and records nothing", async () => {
  const stop = new AbortController();
  const ctx = context(args(), stop.signal);
  await withCluster({ ...CLUSTER, calls: [found, minted] }, async () => {
    const err = await withFetch(
      salmon(() => {
        stop.abort();
        return NEVER;
      }),
      () =>
        ends(assertRejects(() => model.methods.test.execute({}, ctx), Error)),
    );
    assertStringIncludes(err.message, "could not be sent");
    assertStringIncludes(err.message, "cancelled");
  });
  assertEquals(ctx.writes, []);
});

Deno.test("the method that changes something says so", () => {
  assertEquals(model.methods.test.kind, "action");
});
