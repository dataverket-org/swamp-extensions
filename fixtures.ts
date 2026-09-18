/**
 * Canned `openstack ... -f json` output for tests.
 *
 * Every object mirrors what python-openstackclient 10.3.0 (released
 * 2026-08-27, the latest stable release as of August 2026) prints against an
 * OpenStack 2026.1 cloud, captured from real `show` calls and then
 * anonymised: RFC 5737 addresses, made-up UUIDs and project ids. Field names,
 * nesting, and value types are unchanged. Not shipped.
 *
 * @module
 */

/** `openstack --version` */
export const CLI_VERSION = "openstack 10.3.0";

export const PROJECT = "0123456789abcdef0123456789abcdef";
export const USER = "fedcba9876543210fedcba9876543210";
export const EXT_NET = "2f6ae1d2-039e-4104-ae48-176f9ce4d735";
export const PRIV_NET = "3c6d31a5-9c4a-4bf6-9ad1-38e3a07149e5";

/** `openstack server show <id>` for an active image-booted server. */
export const SERVER_SHOW = {
  "OS-DCF:diskConfig": "AUTO",
  "OS-EXT-AZ:availability_zone": "zone-a",
  "OS-EXT-SRV-ATTR:host": null,
  "OS-EXT-SRV-ATTR:hostname": "web-01",
  "OS-EXT-SRV-ATTR:hypervisor_hostname": null,
  "OS-EXT-SRV-ATTR:instance_name": null,
  "OS-EXT-SRV-ATTR:kernel_id": null,
  "OS-EXT-SRV-ATTR:launch_index": null,
  "OS-EXT-SRV-ATTR:ramdisk_id": null,
  "OS-EXT-SRV-ATTR:reservation_id": null,
  "OS-EXT-SRV-ATTR:root_device_name": null,
  "OS-EXT-SRV-ATTR:user_data": null,
  "OS-EXT-STS:power_state": 1,
  "OS-EXT-STS:task_state": null,
  "OS-EXT-STS:vm_state": "active",
  "OS-SRV-USG:launched_at": "2026-09-15T10:28:21.000000",
  "OS-SRV-USG:terminated_at": null,
  accessIPv4: "",
  accessIPv6: "",
  addresses: {
    "private-net": ["192.0.2.10", "203.0.113.20"],
  },
  config_drive: "",
  created: "2026-09-15T10:28:16Z",
  description: null,
  flavor: {
    name: "m5.medium",
    original_name: "m5.medium",
    description: null,
    disk: 25,
    is_public: true,
    ram: 4096,
    vcpus: 1,
    swap: 0,
    ephemeral: 0,
    is_disabled: null,
    rxtx_factor: null,
    extra_specs: {
      "aggregate_instance_extra_specs:hardware:generation": "gen5",
    },
    id: "m5.medium",
    location: null,
  },
  hostId: "5576ffc29a3b73a627059d86980f0b8eb70b0cdde14516f63cda4668",
  host_status: null,
  id: "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8",
  image: "Debian GNU/Linux 13 (Trixie) (5021ee7c-1bcb-49b5-9f96-d477611b29d5)",
  key_name: "ops-key",
  locked: false,
  locked_reason: null,
  name: "web-01",
  progress: 0,
  project_id: PROJECT,
  properties: { role: "web" },
  security_groups: [{ name: "ssh" }, { name: "default" }],
  server_groups: [],
  status: "ACTIVE",
  tags: ["web"],
  trusted_image_certificates: null,
  updated: "2026-09-15T10:29:04Z",
  user_id: USER,
  volumes_attached: [{ id: "7f84cddf-5cfd-45a9-9048-6026b41c5a45" }],
};

/** A second server, volume-booted and shut off, sharing no name. */
export const SERVER_SHOW_2 = {
  ...SERVER_SHOW,
  "OS-EXT-STS:power_state": 4,
  "OS-EXT-STS:vm_state": "stopped",
  "OS-SRV-USG:launched_at": null,
  addresses: { "private-net": ["192.0.2.11"] },
  id: "a68effa4-132f-4312-8a2c-4aebca678228",
  image: "N/A (booted from volume)",
  name: "db-01",
  status: "SHUTOFF",
  tags: [],
  volumes_attached: [],
};

/** `openstack image show <id>` */
export const IMAGE_SHOW = {
  checksum: "2ef22a6a4f9339db350e93900923c693",
  container_format: "bare",
  created_at: "2021-01-06T12:26:35Z",
  disk_format: "raw",
  file: "/v2/images/8d88079f-5419-4795-bcba-aa647897e032/file",
  id: "8d88079f-5419-4795-bcba-aa647897e032",
  min_disk: 10,
  min_ram: 0,
  name: "Debian GNU/Linux 13 (Trixie)",
  owner: "e3be6ef418f0430da4a997cefd39a863",
  properties: {
    os_hidden: false,
    description: null,
    locations: [{ url: "rbd://example/glance-images/x/snap", metadata: {} }],
    direct_url: "rbd://example/glance-images/x/snap",
    architecture: "x86_64",
    os_distro: "debian",
    os_version: "13",
    hw_disk_bus: "virtio",
  },
  protected: false,
  schema: "/v2/schemas/image",
  size: 8589934592,
  status: "active",
  tags: [],
  updated_at: "2023-01-20T10:28:11Z",
  visibility: "public",
};

/** `openstack keypair show <name>` (public half; private_key null). */
export const KEYPAIR_SHOW = {
  created_at: "2026-09-10T08:00:00.000000",
  fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  id: "ops-key",
  is_deleted: false,
  name: "ops-key",
  private_key: null,
  public_key:
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExample ops\n",
  type: "ssh",
  user_id: USER,
};

/** `openstack keypair create <name>` when Nova generates the key. */
export const KEYPAIR_CREATE_GENERATED = {
  ...KEYPAIR_SHOW,
  name: "gen-key",
  id: "gen-key",
  private_key:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----\n",
};

/** `openstack server group show <id>` (microversion >= 2.64). */
export const SERVER_GROUP_SHOW = {
  id: "9c0e8b1a-4d2f-4c3b-8a7e-1f2d3c4b5a69",
  members: ["55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8"],
  name: "web-spread",
  policy: "anti-affinity",
  project_id: PROJECT,
  rules: { max_server_per_host: 1 },
  user_id: USER,
};

/** `openstack volume show <id>` for an attached volume. */
export const VOLUME_SHOW = {
  attachments: [
    {
      id: "7f84cddf-5cfd-45a9-9048-6026b41c5a45",
      attachment_id: "2e096722-4d9b-40d5-b783-cdd9f8853f38",
      volume_id: "7f84cddf-5cfd-45a9-9048-6026b41c5a45",
      server_id: "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8",
      host_name: null,
      device: "/dev/vdb",
      attached_at: "2026-09-18T08:03:45.000000",
    },
  ],
  availability_zone: "zone-a",
  backup_id: null,
  bootable: false,
  cluster_name: null,
  consumes_quota: true,
  created_at: "2026-09-18T07:55:51.000000",
  description: "state volume",
  encrypted: false,
  group_id: null,
  id: "7f84cddf-5cfd-45a9-9048-6026b41c5a45",
  multiattach: false,
  name: "web-01-state",
  "os-vol-host-attr:host": null,
  "os-vol-mig-status-attr:migstat": null,
  "os-vol-mig-status-attr:name_id": null,
  "os-vol-tenant-attr:tenant_id": PROJECT,
  properties: { purpose: "state" },
  provider_id: null,
  replication_status: null,
  service_uuid: "9a560e78-1ede-46af-87e6-3eea1d6066bb",
  shared_targets: false,
  size: 20,
  snapshot_id: null,
  source_volid: null,
  status: "in-use",
  type: "SSD",
  updated_at: "2026-09-18T08:03:45.000000",
  user_id: USER,
  volume_type_id: "e877f845-7fef-4bbd-9a43-87e46291772a",
};

/** `openstack floating ip show <id>` for a bound IP. */
export const FLOATING_IP_SHOW = {
  created_at: "2026-09-07T16:46:13Z",
  description: "web-01 public",
  dns_domain: "",
  dns_name: "",
  fixed_ip_address: "192.0.2.10",
  floating_ip_address: "203.0.113.20",
  floating_network_id: EXT_NET,
  id: "1b049cfe-666b-4c8c-aa3f-cc95b2271e16",
  name: "203.0.113.20",
  port_details: {
    name: "",
    network_id: PRIV_NET,
    mac_address: "fa:16:3e:33:bc:fa",
    admin_state_up: true,
    status: "ACTIVE",
    device_id: "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8",
    device_owner: "compute:nova",
  },
  port_id: "93ea4e7c-df2b-4d29-b16b-94f41850dc44",
  project_id: PROJECT,
  qos_policy_id: null,
  revision_number: 1,
  router_id: "5efb7f7f-d29e-49d4-83bc-b0b6b37af68a",
  status: "ACTIVE",
  subnet_id: null,
  tags: [],
  updated_at: "2026-09-07T16:46:14Z",
};

/** A free (unbound) floating IP. */
export const FLOATING_IP_FREE = {
  ...FLOATING_IP_SHOW,
  description: "",
  fixed_ip_address: null,
  floating_ip_address: "203.0.113.21",
  id: "798de84c-5efc-407a-b1ec-09ac466667ea",
  name: "203.0.113.21",
  port_details: null,
  port_id: null,
  router_id: null,
  status: "DOWN",
};

/** `openstack security group show <id>` */
export const SECURITY_GROUP_SHOW = {
  created_at: "2026-09-07T16:46:14Z",
  description: "ssh from the office",
  id: "0ae8b48c-7db0-4903-ba95-5a2a081ea6c9",
  is_shared: false,
  name: "ssh",
  project_id: PROJECT,
  revision_number: 6,
  rules: [
    {
      id: "2a57f453-55e5-427d-9103-d17ebf52a9bf",
      tenant_id: PROJECT,
      security_group_id: "0ae8b48c-7db0-4903-ba95-5a2a081ea6c9",
      ethertype: "IPv4",
      direction: "ingress",
      protocol: "tcp",
      port_range_min: 22,
      port_range_max: 22,
      remote_ip_prefix: "198.51.100.0/24",
      remote_address_group_id: null,
      normalized_cidr: "198.51.100.0/24",
      remote_group_id: null,
      standard_attr_id: 59706,
      description: "office",
      tags: [],
      created_at: "2026-09-07T16:46:14Z",
      updated_at: "2026-09-07T16:46:14Z",
      revision_number: 0,
      project_id: PROJECT,
    },
    {
      id: "60afb80a-07c5-46e6-be06-d1210759e0c3",
      tenant_id: PROJECT,
      security_group_id: "0ae8b48c-7db0-4903-ba95-5a2a081ea6c9",
      ethertype: "IPv4",
      direction: "egress",
      protocol: null,
      port_range_min: null,
      port_range_max: null,
      remote_ip_prefix: null,
      remote_address_group_id: null,
      normalized_cidr: null,
      remote_group_id: null,
      standard_attr_id: 59709,
      description: null,
      tags: [],
      created_at: "2026-09-07T16:46:14Z",
      updated_at: "2026-09-07T16:46:14Z",
      revision_number: 0,
      project_id: PROJECT,
    },
  ],
  stateful: true,
  tags: [],
  updated_at: "2026-09-08T16:23:04Z",
};

/** `openstack <noun> list -c ID` rows. */
export function idRows(...ids: string[]): { ID: string }[] {
  return ids.map((ID) => ({ ID }));
}

/** `openstack network show <id>` for a tenant network. */
export const NETWORK_SHOW = {
  admin_state_up: true,
  availability_zone_hints: [],
  availability_zones: ["nova"],
  created_at: "2026-09-06T12:01:20Z",
  description: "",
  dns_domain: null,
  id: PRIV_NET,
  ipv4_address_scope: null,
  ipv6_address_scope: null,
  is_default: null,
  is_vlan_qinq: null,
  is_vlan_transparent: null,
  mtu: 1442,
  name: "private-net",
  port_security_enabled: true,
  project_id: PROJECT,
  "provider:network_type": null,
  "provider:physical_network": null,
  "provider:segmentation_id": null,
  pvlan: null,
  qos_policy_id: null,
  revision_number: 2,
  "router:external": false,
  segments: null,
  shared: false,
  status: "ACTIVE",
  subnets: ["e1e8839f-8154-40d8-84d3-38c01020b27e"],
  tags: [],
  updated_at: "2026-09-06T12:01:21Z",
};

/** The external (provider) network. */
export const NETWORK_EXTERNAL = {
  ...NETWORK_SHOW,
  id: EXT_NET,
  name: "ext-net",
  project_id: "e3be6ef418f0430da4a997cefd39a863",
  "router:external": true,
  shared: false,
  subnets: ["1afef4bd-28f5-43d8-92c6-d0a1e101aec8"],
};

/** `openstack subnet show <id>` */
export const SUBNET_SHOW = {
  allocation_pools: [{ start: "192.0.2.100", end: "192.0.2.200" }],
  cidr: "192.0.2.0/24",
  created_at: "2026-09-06T12:01:21Z",
  description: "",
  dns_nameservers: ["198.51.100.53", "198.51.100.54"],
  dns_publish_fixed_ip: null,
  enable_dhcp: true,
  gateway_ip: "192.0.2.1",
  host_routes: [{ destination: "203.0.113.0/24", nexthop: "192.0.2.254" }],
  id: "e1e8839f-8154-40d8-84d3-38c01020b27e",
  ip_version: 4,
  ipv6_address_mode: null,
  ipv6_ra_mode: null,
  name: "private-subnet",
  network_id: PRIV_NET,
  project_id: PROJECT,
  revision_number: 0,
  segment_id: null,
  service_types: [],
  subnetpool_id: null,
  tags: [],
  updated_at: "2026-09-06T12:01:21Z",
};

/** `openstack router show <id>` with a gateway and one interface. */
export const ROUTER_SHOW = {
  admin_state_up: true,
  availability_zone_hints: [],
  availability_zones: ["nova"],
  created_at: "2026-09-06T12:01:34Z",
  description: "",
  enable_ndp_proxy: null,
  external_gateway_info: {
    network_id: EXT_NET,
    external_fixed_ips: [
      {
        subnet_id: "1afef4bd-28f5-43d8-92c6-d0a1e101aec8",
        ip_address: "203.0.113.2",
      },
    ],
    enable_snat: true,
  },
  flavor_id: null,
  id: "5efb7f7f-d29e-49d4-83bc-b0b6b37af68a",
  interfaces_info: [
    {
      port_id: "f4cc5fc3-8593-4070-9207-f215fbf90ef9",
      ip_address: "192.0.2.1",
      subnet_id: "e1e8839f-8154-40d8-84d3-38c01020b27e",
    },
  ],
  name: "private-gw",
  project_id: PROJECT,
  revision_number: 4,
  routes: [{ destination: "203.0.113.0/24", nexthop: "192.0.2.254" }],
  status: "ACTIVE",
  tags: [],
  updated_at: "2026-09-06T12:01:50Z",
};

/** `openstack port show <id>` for a server NIC. */
export const PORT_SHOW = {
  admin_state_up: true,
  allowed_address_pairs: [{
    mac_address: "fa:16:3e:6c:83:8c",
    ip_address: "192.0.2.198",
  }],
  binding_host_id: null,
  binding_profile: {},
  binding_vif_details: {},
  binding_vif_type: null,
  binding_vnic_type: "normal",
  created_at: "2026-09-08T20:00:22Z",
  data_plane_status: null,
  description: "",
  device_id: "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8",
  device_owner: "compute:zone-a",
  device_profile: null,
  dns_assignment: [],
  dns_domain: null,
  dns_name: null,
  extra_dhcp_opts: [],
  fixed_ips: [{
    subnet_id: "e1e8839f-8154-40d8-84d3-38c01020b27e",
    ip_address: "192.0.2.10",
  }],
  hardware_offload_type: null,
  hints: "",
  id: "81d13fee-4f00-4e12-8de4-10a1e1570c2b",
  ip_allocation: null,
  mac_address: "fa:16:3e:6c:83:8c",
  name: "web-01-eth0",
  network_id: PRIV_NET,
  numa_affinity_policy: null,
  port_security_enabled: true,
  project_id: PROJECT,
  propagate_uplink_status: null,
  pvlan_type: null,
  pvlan_community: null,
  resource_request: null,
  revision_number: 6,
  qos_network_policy_id: null,
  qos_policy_id: null,
  security_group_ids: ["0ae8b48c-7db0-4903-ba95-5a2a081ea6c9"],
  status: "ACTIVE",
  tags: [],
  trunk_details: null,
  trusted: null,
  updated_at: "2026-09-08T20:00:24Z",
};

/** `openstack flavor show <id>` */
export const FLAVOR_SHOW = {
  "OS-FLV-DISABLED:disabled": false,
  "OS-FLV-EXT-DATA:ephemeral": 0,
  access_project_ids: null,
  description: null,
  disk: 25,
  id: "28",
  name: "m5.medium",
  "os-flavor-access:is_public": true,
  properties: { "quota:disk_read_iops_sec": "500" },
  ram: 4096,
  rxtx_factor: 1.0,
  swap: 0,
  vcpus: 1,
};

/** `openstack availability zone list --compute`; one row per host. */
export const AZ_ROWS = [
  { "Zone Name": "zone-a", "Zone Status": "available" },
  { "Zone Name": "zone-a", "Zone Status": "available" },
  { "Zone Name": "zone-b", "Zone Status": "not available" },
];

/** `openstack application credential show <id>` — identity prints capitalised columns. */
export const APPCRED_SHOW = {
  ID: "f6f81e3038b54204abfdd9efcede88b2",
  Name: "swamp",
  Description: null,
  "Project ID": PROJECT,
  Roles: [
    {
      id: "216585327cc5405aad334470586ff9d6",
      name: "reader",
      domain_id: null,
      description: null,
      options: {},
    },
    {
      id: "5b47bdb2a0dd4243a5b77cabbcb88e39",
      name: "member",
      domain_id: null,
      description: null,
      options: {},
    },
  ],
  Unrestricted: false,
  "Access Rules": null,
  "Expires At": null,
};

/** `openstack application credential create <name>` adds the one-time Secret. */
export const APPCRED_CREATE = {
  ...APPCRED_SHOW,
  ID: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  Name: "rotated",
  Secret: "example-secret-shown-once",
};

/** `openstack volume snapshot show <id>` */
export const SNAPSHOT_SHOW = {
  created_at: "2026-09-18T09:00:00.000000",
  description: "before upgrade",
  id: "3d2c1b0a-9f8e-4d7c-b6a5-4f3e2d1c0b9a",
  name: "web-01-state-pre-upgrade",
  properties: {},
  size: 20,
  status: "available",
  updated_at: "2026-09-18T09:00:10.000000",
  volume_id: "7f84cddf-5cfd-45a9-9048-6026b41c5a45",
};

/** `openstack volume type show <id>` */
export const VOLUME_TYPE_SHOW = {
  access_project_ids: null,
  description: "Fast SSD",
  id: "e877f845-7fef-4bbd-9a43-87e46291772a",
  is_public: true,
  name: "SSD",
  properties: { volume_backend_name: "ssd" },
};
