# pfSense HA / CARP Builder — Claude Code Project

Standalone tool project. Generates paired primary/secondary pfSense configs for CARP HA from a config.xml backup. No customer data lives here and none should be added — this repo is pure tooling.

## Files

```
pfsense-ha-builder.html   # Standalone browser tool. SOURCE OF TRUTH. Single self-contained file.
test-fixtures/            # Synthetic config.xml only — never a real backup.
```

## Domain facts worth not re-deriving

Verified directly against pfSense's own PHP source (github.com/pfsense/pfsense, `src/usr/local/www/` and `src/etc/rc.filter_synchronize`) rather than assumed from memory — these are load-bearing for correctness:

- **`hasync` is a top-level config.xml element**, not nested under `<system>`. Fields: `pfsyncenabled`, `pfsyncinterface`, `pfsyncpeerip`, `synchronizetoip`, `username`, `password`, plus ~20 boolean `synchronize*` section flags (see `system_hasync.php`).
- **CARP VIPs** live at `virtualip/vip` with `mode=carp`: `interface`, `type`, `subnet`, `subnet_bits`, `vhid`, `advbase`, `advskew`, `password`, `descr`, `uniqid` (see `firewall_virtual_ip_edit.php`).
- **The primary's own XMLRPC config-sync engine adds +100 to `advskew`** (capped 254) when pushing a CARP VIP to the secondary, and **rewrites `dhcpd/<iface>/failover_peerip` to the sender's own interface IP** on every sync (see `rc.filter_synchronize`, functions `backup_vip_config_section()` and the dhcpd loop in `carp_sync_xml()`). The generator bakes in these post-sync values directly so both files are correct from first boot, not just after the first sync fires.
- **Config sync is one-directional.** `synchronizetoip` should be set on the primary only; setting it on the secondary risks a sync loop/conflict. The secondary's copy is left blank.
- **DHCP backend is `dhcpbackend`** (top-level, `isc` or `kea`, default `isc` — see `pfsense-utils.inc`, `dhcp_get_backend()`). Kea's HA is a different mechanism (hot-standby, mTLS peering) and is genuinely not compatible with the ISC `failover_peerip` approach — confirmed independently by Heart's own `~/second-brain/team/pfsense-configuration-standard.md`, Section 3. Never synthesize Kea HA config from assumption; it's flagged out of scope in the UI instead.
- **Interface `gateway` is a name reference** (into `gateways/gateway_item`), not a literal IP — the secondary keeps the same gateway reference, since it shares the same upstream gateway; only `ipaddr` changes.

## Invariants to preserve

1. **Fully offline, single distributable file.** No network calls, no server dependency. A pfSense backup can contain the admin password hash, CARP secrets, and VPN private keys — nothing should ever leave the browser tab.
2. **Parser is schema-tolerant, not version-branching.** It only reads/writes the specific tags above and clones everything else in the source config verbatim. Don't add pfSense-version-specific branches without verifying against source first — the whole point of the tolerant design is to survive schema drift across CE/Plus releases without silently corrupting unrelated sections.
3. **Never guess an XML tag name from memory alone.** Every field this tool writes was checked against pfSense's own PHP source. If a new field needs adding, verify it the same way (`curl raw.githubusercontent.com/pfsense/pfsense/master/src/...`) before writing generator code — a wrong tag name is a config that silently doesn't work on a real firewall.
4. **Out-of-scope sections (IPsec, OpenVPN, certs, Kea HA) are flagged, never silently modified or silently dropped.**
5. **Always creates a new dedicated SYNC interface** — matches Heart's stated build convention (direct firewall-to-firewall connection). Don't add a "reuse an existing interface" path without being asked.

## Related

Heart's pfSense HA/DHCP policy lives in the vault at `~/second-brain/team/pfsense-configuration-standard.md` (HA stays enabled — not a tech-level decision to disable; DHCP is served by the firewall, not access switches). This tool exists to make building HA pairs correctly the path of least resistance.
