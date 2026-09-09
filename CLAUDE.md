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
5. **SYNC interface source is a choice, not a fixed behavior**: create new, or reuse an existing interface slot that's present in the config but unused (no `<ipaddr>`, not `<enable>`d). This was added after a real test run — a lab unit had no spare physical NIC, and the fix was moving another interface onto a VLAN first (outside this tool) to free up a slot, then reusing that slot here. On reuse, never touch the primary's `<if>` — it's already real hardware in the source config.
6. **VLAN pseudo-interfaces are locked, not editable**, in the "secondary physical port" field. `<if>` for a VLAN interface is a computed value (parent port + tag from the top-level `<vlans>` section), not a free-form NIC name — editing it without also fixing the matching `<vlans>` entry produces a dangling reference. Detected by matching each interface's `physIf` against `vlans/vlan/vlanif`.
7. **Per-interface VIP strategy defaults to "current IP becomes the VIP," not "keep current IP, VIP is new."** CARP only protects an address that something downstream actually points at — if the primary keeps its current IP, nothing is protected unless every downstream device is repointed at the new VIP, which this tool can't do. Reusing the current IP needs zero downstream changes, which is why it's the default. This also means the primary's own `<ipaddr>` is no longer untouched in the generator — it changes too, in "reuse" mode.
8. **DHCP's `gateway` override is not optional when "reuse" mode applies to a DHCP-enabled interface.** Verified in `services.inc`: pfSense falls back to the interface's own IP for the DHCP-issued default gateway when `dhcpd/<iface>/gateway` is empty. After a "reuse" swap that fallback is the new non-floating address, so the override must be set explicitly to the VIP — this isn't a preference toggle, the alternative is just wrong.
9. **Output gets a whitespace-only reindent pass (`reindentXml`) before serialization**, since DOM `appendChild` doesn't insert the surrounding indentation a hand-edited file would have — newly appended elements landed crammed on one line otherwise (found reviewing real output against the original). The pass only ever touches pure-whitespace text nodes between element children; if a container has any non-whitespace, non-element child it's left alone entirely, so it can never silently drop something unexpected. Separately, XMLSerializer always normalizes `<tag></tag>` to `<tag/>` document-wide — that's an unavoidable, harmless side effect of the DOMParser/XMLSerializer round-trip (pfSense's parser treats them identically), not something to try to "fix."
10. **A physical port is "claimed" the moment any interface entry declares it in `<if>`, regardless of whether that interface is actually configured.** pfSense's own interface-assignment page won't let two logical interfaces share one physical port even if one of them has no address or is disabled — so `usedPhysIfs` (the SYNC "create new" collision check) must stay strict and count spare/unconfigured slots too. Don't relax this to "only count configured interfaces" — that was tried and reverted after producing a config with the same physical port assigned to two interface entries. The "reuse existing" SYNC source is the correct path for a spare-but-defined slot; the fix for a confusing block there is a clearer error message pointing at that path, not loosening the check.

## Related

Heart's pfSense HA/DHCP policy lives in the vault at `~/second-brain/team/pfsense-configuration-standard.md` (HA stays enabled — not a tech-level decision to disable; DHCP is served by the firewall, not access switches). This tool exists to make building HA pairs correctly the path of least resistance.
