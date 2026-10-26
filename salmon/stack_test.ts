import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import {
  composeProject,
  GlobalArgsSchema,
  LDIF,
  localIssuerUrl,
  salmonYaml,
} from "./stack.ts";

const args = (over: Record<string, unknown> = {}) =>
  GlobalArgsSchema.parse({ project: "t", port: 18090, ...over });

Deno.test("only Salmon's port is published", () => {
  const p = JSON.parse(composeProject(args()));
  assertEquals(p.services.salmon.ports, ["18090:8080"]);
  assertEquals(p.services.postgres.ports, undefined);
  assertEquals(p.services.ldap.ports, undefined);
});

Deno.test("Salmon runs in /tmp with salmon.yaml mounted there", () => {
  const p = JSON.parse(composeProject(args()));
  assertEquals(p.services.salmon.working_dir, "/tmp");
  assertEquals(p.services.salmon.configs, [
    { source: "salmon-yaml", target: "/tmp/salmon.yaml" },
  ]);
  assertEquals(p.configs["salmon-yaml"].content, salmonYaml(args()));
});

Deno.test("Salmon waits for healthy Postgres and LDAP", () => {
  const p = JSON.parse(composeProject(args()));
  assertEquals(p.services.salmon.depends_on, {
    postgres: { condition: "service_healthy" },
    ldap: { condition: "service_healthy" },
  });
});

Deno.test("extra networks are joined as external ones", () => {
  const p = JSON.parse(composeProject(args({ networks: ["kind"] })));
  assertEquals(p.services.salmon.networks, ["default", "kind"]);
  assertEquals(p.networks, { kind: { name: "kind", external: true } });
  assertEquals(JSON.parse(composeProject(args())).networks, {});
});

Deno.test("the LDAP seed is mounted and copied before use", () => {
  const p = JSON.parse(composeProject(args()));
  assertEquals(p.services.ldap.command, ["--copy-service"]);
  assertEquals(p.services.ldap.configs.length, Object.keys(LDIF).length);
  assert(
    LDIF["03-groups.ldif"].includes(
      "cn=Registry-Push,ou=groups,dc=salmon,dc=local\nobjectClass: groupOfNames\ncn: Registry-Push\nowner: cn=Salmon-Registry-Administrator",
    ),
  );
});

Deno.test("salmon.yaml names the issuer, the stack's LDAP and the admins", () => {
  const y = salmonYaml(args({ issuerUrl: "http://10.0.0.1:18090/issuer/" }));
  assert(y.startsWith("issuer_url: http://10.0.0.1:18090/issuer/\n"));
  assert(y.includes("host: ldap://ldap:389"));
  assert(y.includes("  - ldap/Salmon-Administrator"));
});

Deno.test("the issuer must be served at /issuer/", () => {
  assertThrows(() => args({ issuerUrl: "http://localhost:8080/other/" }));
  assertEquals(localIssuerUrl(args()), "http://127.0.0.1:18090/issuer/");
});
