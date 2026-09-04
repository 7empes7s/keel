# KEEL backup timers

The tiered backup units are deliberately not installed or started by the build. An operator may
install and enable them after confirming the Collector registration and `/etc/keel/db.env` are
configured for the intended tenant:

```sh
sudo install -m 0644 ops/keel-backup-tier1.service ops/keel-backup-tier1.timer /etc/systemd/system/
sudo install -m 0644 ops/keel-backup-tier2.service ops/keel-backup-tier2.timer /etc/systemd/system/
sudo install -m 0644 ops/keel-backup-tier3.service ops/keel-backup-tier3.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now keel-backup-tier1.timer keel-backup-tier2.timer keel-backup-tier3.timer
```
