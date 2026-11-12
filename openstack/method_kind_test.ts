/**
 * Every model here is a collection, so no method may leave swamp to infer the
 * lifecycle kind "delete" from its name: swamp would then mark every stored
 * resource of the model deleted, not just the one that is gone (common.ts).
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model as applicationCredential } from "./application_credential.ts";
import { model as availabilityZone } from "./availability_zone.ts";
import { model as flavor } from "./flavor.ts";
import { model as floatingIp } from "./floating_ip.ts";
import { model as image } from "./image.ts";
import { model as keypair } from "./keypair.ts";
import { model as network } from "./network.ts";
import { model as port } from "./port.ts";
import { model as router } from "./router.ts";
import { model as securityGroup } from "./security_group.ts";
import { model as serverGroup } from "./server_group.ts";
import { model as server } from "./server.ts";
import { model as snapshot } from "./snapshot.ts";
import { model as subnet } from "./subnet.ts";
import { model as volume } from "./volume.ts";
import { model as volumeType } from "./volume_type.ts";

type Methods = Record<string, { kind?: string; description: string }>;

const MODELS: Record<string, { methods: Methods }> = {
  applicationCredential,
  availabilityZone,
  flavor,
  floatingIp,
  image,
  keypair,
  network,
  port,
  router,
  securityGroup,
  serverGroup,
  server,
  snapshot,
  subnet,
  volume,
  volumeType,
};

/** Swamp's inferMethodKind for the names that infer "delete". */
function swampKind(name: string, def: { kind?: string }): string | undefined {
  if (def.kind) return def.kind;
  const lower = name.toLowerCase();
  if (lower === "delete" || lower === "destroy" || lower === "remove") {
    return "delete";
  }
  return undefined;
}

Deno.test("no method of any model ends up with the lifecycle kind delete", () => {
  const offenders: string[] = [];
  for (const [type, m] of Object.entries(MODELS)) {
    for (const [name, def] of Object.entries(m.methods)) {
      if (swampKind(name, def) === "delete") offenders.push(`${type}.${name}`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("the twelve delete methods are actions", () => {
  const kinds = Object.entries(MODELS)
    .filter(([, m]) => "delete" in m.methods)
    .map(([type, m]) => [type, m.methods.delete.kind]);
  assertEquals(kinds.length, 12);
  for (const [type, kind] of kinds) assertEquals(kind, "action", type);
});

Deno.test("a method named like swamp's delete without a kind is caught", () => {
  assertEquals(swampKind("delete", {}), "delete");
  assertEquals(swampKind("Remove", {}), "delete");
  assertEquals(swampKind("destroy", { kind: "action" }), "action");
  assertEquals(swampKind("removeRule", {}), undefined);
});
