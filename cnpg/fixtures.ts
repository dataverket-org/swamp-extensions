/**
 * Objects as kubectl prints them, trimmed to what the parsers read, with
 * marker values planted where a real object holds credential references and
 * command output. Shapes follow CloudNativePG 1.30.1 and the Barman Cloud
 * plugin 0.15.1 as recorded from a kind cluster.
 */
import { PLANTED } from "./test_support.ts";

const s3Credentials = {
  accessKeyId: { name: PLANTED.secretName, key: PLANTED.secretKey },
  secretAccessKey: { name: PLANTED.secretName, key: PLANTED.secretKey },
};

/** A healthy one-instance Cluster with the in-tree barmanObjectStore method. */
export const clusterOne = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: { name: "one", namespace: "pg" },
  spec: {
    instances: 1,
    imageName: "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie",
    storage: { size: "1Gi", storageClass: "standard" },
    walStorage: { size: "512Mi" },
    backup: {
      retentionPolicy: "7d",
      target: "prefer-standby",
      barmanObjectStore: {
        destinationPath: "s3://one/",
        endpointURL: `http://user:${PLANTED.password}@s3.pg.svc:7070`,
        serverName: "one-v2",
        s3Credentials,
      },
    },
  },
  status: {
    phase: "Cluster in healthy state",
    instances: 1,
    readyInstances: 1,
    currentPrimary: "one-1",
    targetPrimary: "one-1",
    currentPrimaryTimestamp: "2026-11-10T09:41:20.000000Z",
    targetPrimaryTimestamp: "2026-11-10T09:40:42.000000Z",
    timelineID: 1,
    instanceNames: ["one-1"],
    instancesStatus: { healthy: ["one-1"] },
    instancesReportedState: {
      "one-1": { isPrimary: true, timeLineID: 1, ip: "192.0.2.12" },
    },
    image: "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie",
    pgDataImageInfo: {
      image: "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie",
      majorVersion: 18,
    },
    conditions: [
      {
        type: "Ready",
        status: "True",
        reason: "ClusterIsReady",
        message: "Cluster is Ready",
        lastTransitionTime: "2026-11-10T09:41:30Z",
      },
      {
        type: "ContinuousArchiving",
        status: "True",
        reason: "ContinuousArchivingSuccess",
        message: "Continuous archiving is working",
        lastTransitionTime: "2026-11-10T09:41:40Z",
      },
      {
        type: "LastBackupSucceeded",
        status: "True",
        reason: "LastBackupSucceeded",
        message: "Backup was successful",
        lastTransitionTime: "2026-11-10T09:45:00Z",
      },
    ],
    firstRecoverabilityPoint: "2026-11-10T09:44:10Z",
    lastSuccessfulBackup: "2026-11-10T09:44:12Z",
    secretsResourceVersion: { superuserSecretVersion: PLANTED.token },
  },
};

/** A three-instance Cluster that archives through the Barman Cloud plugin. */
export const clusterThree = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: { name: "three", namespace: "pg" },
  spec: {
    instances: 3,
    storage: { size: "1Gi" },
    plugins: [
      {
        name: "barman-cloud.cloudnative-pg.io",
        isWALArchiver: true,
        parameters: {
          barmanObjectName: "store",
          somethingElse: PLANTED.token,
        },
      },
      { name: "other.example.org", enabled: false, parameters: {} },
    ],
  },
  status: {
    phase: "Cluster in healthy state",
    instances: 3,
    readyInstances: 3,
    currentPrimary: "three-1",
    targetPrimary: "three-1",
    timelineID: 1,
    instanceNames: ["three-1", "three-2", "three-3"],
    instancesStatus: { healthy: ["three-1", "three-2", "three-3"] },
    instancesReportedState: {
      "three-1": { isPrimary: true, timeLineID: 1 },
      "three-2": { isPrimary: false, timeLineID: 1 },
      "three-3": { isPrimary: false, timeLineID: 1 },
    },
    image: "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie",
    pgDataImageInfo: { majorVersion: 18 },
    pluginStatus: [
      { name: "barman-cloud.cloudnative-pg.io", version: "0.15.1" },
    ],
    conditions: [
      { type: "Ready", status: "True", reason: "ClusterIsReady" },
      {
        type: "ContinuousArchiving",
        status: "True",
        reason: "ContinuousArchivingSuccess",
      },
    ],
  },
};

/** The same Cluster a moment after its primary pod was deleted. */
export const clusterFailingOver = {
  ...clusterThree,
  status: {
    ...clusterThree.status,
    phase: "Failing over",
    phaseReason: "Failing over from three-1 to three-2",
    readyInstances: 2,
    currentPrimary: "three-1",
    targetPrimary: "three-2",
    currentPrimaryFailingSinceTimestamp: "2026-11-10T10:00:00Z",
    instancesStatus: { healthy: ["three-2", "three-3"], failed: ["three-1"] },
    instancesReportedState: {
      "three-2": { isPrimary: false, timeLineID: 1 },
      "three-3": { isPrimary: false, timeLineID: 1 },
    },
    conditions: [
      {
        type: "Ready",
        status: "False",
        reason: "ClusterIsNotReady",
        message: "Cluster Is Not Ready",
      },
    ],
  },
};

/** A Cluster with no backup configuration at all. */
export const clusterNoBackup = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: { name: "nobackup", namespace: "pg" },
  spec: { instances: 1, storage: { size: "1Gi" } },
  status: {
    phase: "Cluster in healthy state",
    readyInstances: 1,
    currentPrimary: "nobackup-1",
    targetPrimary: "nobackup-1",
    instanceNames: ["nobackup-1"],
    conditions: [{ type: "Ready", status: "True" }],
  },
};

/** The ObjectStore the plugin Cluster points at. */
export const objectStore = {
  apiVersion: "barmancloud.cnpg.io/v1",
  kind: "ObjectStore",
  metadata: { name: "store", namespace: "pg" },
  spec: {
    retentionPolicy: "14d",
    configuration: {
      destinationPath: "s3://three/",
      endpointURL: "http://s3.pg.svc:7070",
      s3Credentials,
    },
  },
  status: {
    serverRecoveryWindow: {
      three: {
        firstRecoverabilityPoint: "2026-11-10T09:50:00Z",
        lastSuccessfulBackupTime: "2026-11-10T09:50:05Z",
      },
      another: { lastFailedBackupTime: "2026-11-01T00:00:00Z" },
    },
  },
};

/** A completed on-demand Backup taken with barmanObjectStore. */
export const backupCompleted = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Backup",
  metadata: {
    name: "manual-1",
    namespace: "pg",
    creationTimestamp: "2026-11-10T09:44:00Z",
  },
  spec: { cluster: { name: "one" }, method: "barmanObjectStore" },
  status: {
    phase: "completed",
    method: "barmanObjectStore",
    startedAt: "2026-11-10T09:44:05Z",
    stoppedAt: "2026-11-10T09:44:12Z",
    beginWal: "000000010000000000000004",
    endWal: "000000010000000000000004",
    beginLSN: "0/4000028",
    endLSN: "0/4000158",
    backupId: "backup-20261110094405",
    backupName: "backup-20261110094405",
    destinationPath: "s3://one/",
    endpointURL: `http://user:${PLANTED.password}@s3.pg.svc:7070`,
    serverName: "one",
    instanceID: { podName: "one-1", ContainerID: "containerd://abc" },
    majorVersion: 18,
    s3Credentials,
    commandOutput: PLANTED.commandOutput,
    commandError: PLANTED.commandOutput,
  },
};

/** A failed Backup. */
export const backupFailed = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Backup",
  metadata: {
    name: "bad-1",
    namespace: "pg",
    creationTimestamp: "2026-11-10T09:46:00Z",
  },
  spec: { cluster: { name: "bad" }, method: "barmanObjectStore" },
  status: {
    phase: "failed",
    method: "barmanObjectStore",
    startedAt: "2026-11-10T09:46:01Z",
    stoppedAt: "2026-11-10T09:46:03Z",
    error:
      `exit status 4: could not reach https://key:${PLANTED.password}@s3.example.org with Bearer ${PLANTED.token}`,
    destinationPath: "s3://no-such-bucket/",
    instanceID: { podName: "bad-1" },
    s3Credentials,
  },
};

/** A Backup made by a ScheduledBackup through the plugin. */
export function scheduled(
  name: string,
  createdAt: string,
  phase: string,
  by = "nightly",
  namespace = "pg",
): Record<string, unknown> {
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: {
      name,
      namespace,
      creationTimestamp: createdAt,
      labels: {
        "cnpg.io/cluster": "three",
        "cnpg.io/scheduled-backup": by,
      },
    },
    spec: {
      cluster: { name: "three" },
      method: "plugin",
      pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
    },
    status: {
      phase,
      method: "plugin",
      startedAt: createdAt,
      stoppedAt: phase === "running" ? undefined : createdAt,
      beginWal: "000000020000000000000007",
      endWal: "000000020000000000000007",
      backupId: `id-${name}`,
      instanceID: { podName: "three-2" },
      pluginMetadata: { timeline: "2", clusterUID: "abc" },
    },
  };
}

/** A ScheduledBackup as kubectl prints it. */
export const nightly = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "ScheduledBackup",
  metadata: { name: "nightly", namespace: "pg" },
  spec: {
    schedule: "0 30 3 * * *",
    immediate: true,
    backupOwnerReference: "self",
    cluster: { name: "three" },
    method: "plugin",
    pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
  },
  status: {
    lastCheckTime: "2026-11-10T09:50:00Z",
    lastScheduleTime: "2026-11-10T09:50:00Z",
    nextScheduleTime: "2026-11-11T03:30:00Z",
  },
};

/** A Cloud credential reference of each provider, as the CRD spells them. */
const otherCredentials = {
  azureCredentials: {
    connectionString: { name: PLANTED.secretName, key: PLANTED.secretKey },
    storageAccount: { name: PLANTED.secretName, key: PLANTED.secretKey },
    storageKey: { name: PLANTED.secretName, key: PLANTED.secretKey },
    storageSasToken: { name: PLANTED.secretName, key: PLANTED.secretKey },
  },
  googleCredentials: {
    applicationCredentials: {
      name: PLANTED.secretName,
      key: PLANTED.secretKey,
    },
  },
  endpointCA: { name: PLANTED.secretName, key: PLANTED.secretKey },
};

/**
 * The in-tree Cluster with a marker in every field that holds a credential,
 * a credential reference or free text from elsewhere: nothing of it may be
 * in a record.
 */
export const clusterLoaded = {
  ...clusterOne,
  metadata: {
    name: "one",
    namespace: "pg",
    annotations: {
      "kubectl.kubernetes.io/last-applied-configuration":
        `{"password":"${PLANTED.password}"}`,
    },
  },
  spec: {
    ...clusterOne.spec,
    superuserSecret: { name: PLANTED.secretName },
    enableSuperuserAccess: true,
    bootstrap: {
      initdb: {
        database: "app",
        owner: "app",
        secret: { name: PLANTED.secretName },
        postInitSQL: [`ALTER ROLE app PASSWORD '${PLANTED.password}'`],
        postInitApplicationSQL: [`SELECT '${PLANTED.token}'`],
      },
    },
    externalClusters: [{
      name: "source",
      connectionParameters: {
        host: "db.example.org",
        user: "streaming_replica",
        password: PLANTED.password,
      },
      password: { name: PLANTED.secretName, key: PLANTED.secretKey },
      sslKey: { name: PLANTED.secretName, key: PLANTED.secretKey },
      barmanObjectStore: {
        destinationPath: "s3://source/",
        s3Credentials,
        ...otherCredentials,
      },
    }],
    env: [
      { name: "AWS_SECRET_ACCESS_KEY", value: PLANTED.password },
      {
        name: "FROM_SECRET",
        valueFrom: {
          secretKeyRef: { name: PLANTED.secretName, key: PLANTED.secretKey },
        },
      },
    ],
    envFrom: [{ secretRef: { name: PLANTED.secretName } }],
    managed: {
      roles: [{
        name: "reporting",
        passwordSecret: { name: PLANTED.secretName },
      }],
    },
    certificates: { serverTLSSecret: PLANTED.secretName },
    backup: {
      ...clusterOne.spec.backup,
      barmanObjectStore: {
        ...clusterOne.spec.backup.barmanObjectStore,
        ...otherCredentials,
      },
    },
    plugins: [{
      name: "barman-cloud.cloudnative-pg.io",
      enabled: false,
      parameters: { barmanObjectName: "store", apiKey: PLANTED.token },
    }],
  },
  status: {
    ...clusterOne.status,
    phaseReason:
      `could not reach https://admin:${PLANTED.password}@db.example.org\nAuthorization: Bearer ${PLANTED.token}`,
    pluginStatus: [{
      name: "barman-cloud.cloudnative-pg.io",
      version: "0.15.1",
      status:
        `rpc error: token=${PLANTED.token} at https://k:${PLANTED.password}@s3.example.org`,
    }],
    certificates: { serverTLSSecret: PLANTED.secretName },
    managedRolesStatus: {
      passwordStatus: { reporting: { resourceVersion: PLANTED.token } },
    },
  },
};

/** A Backup and an ObjectStore with every other provider's credentials. */
export const backupLoaded = {
  ...backupCompleted,
  status: { ...backupCompleted.status, ...otherCredentials },
};

/** The ObjectStore with every other provider's credentials. */
export const objectStoreLoaded = {
  ...objectStore,
  spec: {
    ...objectStore.spec,
    configuration: { ...objectStore.spec.configuration, ...otherCredentials },
  },
};

/**
 * An in-tree Cluster hibernated on purpose, shaped as CloudNativePG 1.30.1
 * left one on a kind cluster: the pods are gone, `readyInstances` and
 * `instancesStatus` are no longer in the status, and the phase and the Ready
 * and ContinuousArchiving conditions still say what they said while it ran.
 */
export const clusterHibernated = {
  ...clusterOne,
  metadata: {
    name: "asleep",
    namespace: "pg",
    annotations: { "cnpg.io/hibernation": "on" },
  },
  status: {
    ...clusterOne.status,
    phase: "Cluster in healthy state",
    readyInstances: undefined,
    instancesStatus: undefined,
    instancesReportedState: undefined,
    conditions: [
      ...clusterOne.status.conditions,
      {
        type: "cnpg.io/hibernation",
        status: "True",
        reason: "Hibernated",
        message: "Cluster has been hibernated",
      },
    ],
  },
};

/**
 * `one` with its only instance fenced. Right after the annotation is set the
 * rest of the object still says healthy, ready and archiving, as seen on
 * CloudNativePG 1.30.1.
 */
export const clusterFenced = {
  ...clusterOne,
  metadata: {
    name: "fenced",
    namespace: "pg",
    annotations: { "cnpg.io/fencedInstances": '["one-1"]' },
  },
};

/**
 * A Cluster moved from the in-tree method to the plugin: the plugin archives
 * WAL, and the Cluster status still holds the times of the old method.
 */
export const clusterMoved = {
  ...clusterThree,
  metadata: { name: "moved", namespace: "pg" },
  status: {
    ...clusterThree.status,
    firstRecoverabilityPoint: "2026-01-01T00:00:00Z",
    lastSuccessfulBackup: "2026-01-02T00:00:00Z",
    lastFailedBackup: "2026-01-03T00:00:00Z",
  },
};
