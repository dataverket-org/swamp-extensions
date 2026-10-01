# Live smoke test

`delete-kind.sh` checks against a real cloud what the unit tests check against a
fake: deleting one member of a collection model leaves its siblings readable
through swamp. It creates three 1 GiB volumes and three private images from a
small disk image, deletes one of each, reads the other two back, deletes the one
already gone again, and removes everything, also when a check fails.

```sh
mkdir /tmp/os-smoke && cd /tmp/os-smoke
swamp repo init
swamp extension source add ~/kode/swamp-extensions/openstack
curl -fsSLO https://download.cirros-cloud.net/0.6.3/cirros-0.6.3-x86_64-disk.img
CLOUD=<clouds.yaml entry> IMAGE_FILE=$PWD/cirros-0.6.3-x86_64-disk.img \
  ~/kode/swamp-extensions/openstack/smoke/delete-kind.sh
```

The credential needs a role that may create volumes and private images in its
project. The script creates the models `smoke-volume` and `smoke-image` in the
repository it runs in, and names everything it makes `swamp-smoke-<pid>-*`.
