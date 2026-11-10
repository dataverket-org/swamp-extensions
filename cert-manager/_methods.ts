/**
 * The two reads every cert-manager type has, written once: `list` records
 * every object of a kind in scope plus one inventory, `get` records one
 * object. Each type passes its resource name, its parser and its inventory
 * line.
 *
 * @module
 */
import {
  assertDistinctDataNames,
  buildInventory,
  checkName,
  dataName,
  describeKubectlArgs,
  expectObject,
  getArgs,
  inventoryName,
  isKubectlError,
  KubectlError,
  listArgs,
  listItems,
  listNamespace,
  requireNamespace,
} from "../lib/kubectl.ts";
import { kubectlJson, type MethodContext, type StateItem } from "./_helpers.ts";

/** What `list` and `get` need to know about one kind. */
export interface KindDef<T extends { namespace: string; name: string }> {
  /** The resource spec the records are written to. */
  spec: string;
  /** The kubectl resource name with its API group. */
  resource: string;
  /** The kind, as Kubernetes names it and as a person reads it. */
  label: string;
  /** Reduce one object to the stored record. */
  parse: (item: Record<string, unknown>, now: Date) => T;
  /** The inventory line of one record. */
  item: (record: T) => StateItem;
}

/** What a method returns to swamp. */
export interface MethodResult {
  dataHandles: unknown[];
}

/**
 * Read a list of one kind. An answer that is not a List of that kind is an
 * error, never an empty list. A null namespace reads a cluster-scoped kind,
 * an empty one every namespace.
 */
export async function readList(
  resource: string,
  kind: string,
  namespace: string | null,
  context: Pick<MethodContext, "globalArgs" | "signal">,
): Promise<Record<string, unknown>[]> {
  const args = listArgs(resource, namespace);
  return listItems(
    await kubectlJson(args, context),
    `kubectl ${describeKubectlArgs(args)}`,
    kind,
  );
}

/**
 * List every object of a kind in one namespace or all, record each, and
 * record the inventory. Everything is read and parsed before the first
 * write.
 */
export async function listKind<T extends { namespace: string; name: string }>(
  def: KindDef<T>,
  args: { namespace?: string },
  context: MethodContext,
): Promise<MethodResult> {
  const ns = listNamespace(args.namespace, context.globalArgs.namespace);
  context.logger.info("Listing {kind} objects in {namespace}", {
    kind: def.label,
    namespace: ns || "all namespaces",
  });
  const now = new Date();
  const records = (await readList(def.resource, def.label, ns, context)).map(
    (item) => def.parse(item, now),
  );
  assertDistinctDataNames(def.label, records, [inventoryName(ns)]);
  const inventory = buildInventory(
    ns,
    records.map(def.item),
    now.toISOString(),
  );

  const handles: unknown[] = [];
  for (const record of records) {
    handles.push(
      await context.writeResource(
        def.spec,
        dataName(record.namespace, record.name),
        record,
      ),
    );
  }
  handles.push(
    await context.writeResource("inventory", inventoryName(ns), inventory),
  );
  context.logger.info("Found {count} {kind} objects, {unhealthy} not healthy", {
    count: String(inventory.count),
    kind: def.label,
    unhealthy: String(inventory.unhealthyCount),
  });
  return { dataHandles: handles };
}

/**
 * Read one object by name; `namespace` is null for a cluster-scoped kind.
 * A missing object is a `not-found` error that says so, and an answer that
 * is not the object asked for is an error too.
 */
export async function readOne(
  resource: string,
  kind: string,
  name: string,
  namespace: string | null,
  context: Pick<MethodContext, "globalArgs" | "signal">,
): Promise<Record<string, unknown>> {
  const where = namespace ? `${namespace}/${name}` : name;
  let data: unknown;
  try {
    data = await kubectlJson(getArgs(resource, name, namespace), context);
  } catch (err) {
    if (isKubectlError(err, "not-found")) {
      throw new KubectlError(
        "not-found",
        `${kind} ${where} does not exist`,
        err.stderr,
      );
    }
    throw err;
  }
  return expectObject(data, { kind, name, namespace });
}

/** Read one object of a kind and record it. */
export async function getKind<T extends { namespace: string; name: string }>(
  def: KindDef<T>,
  args: { name: string; namespace?: string },
  context: MethodContext,
): Promise<MethodResult> {
  const name = checkName(args.name, `${def.label} name`);
  const ns = requireNamespace(
    "get",
    args.namespace,
    context.globalArgs.namespace,
  );
  context.logger.info("Reading {kind} {name} in {namespace}", {
    kind: def.label,
    name,
    namespace: ns,
  });
  const record = def.parse(
    await readOne(def.resource, def.label, name, ns, context),
    new Date(),
  );
  const handle = await context.writeResource(
    def.spec,
    dataName(ns, name),
    record,
  );
  context.logger.info("Read {kind} {name}", { kind: def.label, name });
  return { dataHandles: [handle] };
}
