# pfSense HA / CARP Builder

Takes a config backup from a running pfSense firewall and generates a paired configuration for a CARP high-availability secondary: an updated file for the existing (primary) firewall, and a new file for the second physical unit.

## Browser tool

Open `pfsense-ha-builder.html` in any browser. Nothing is uploaded — parsing, generation, and download all happen locally in the tab. Distribute it as a file; no install, no server.

1. Export the primary's backup: Diagnostics > Backup & Restore > Download configuration as XML.
2. Upload it. The tool lists every interface, flags which ones can carry a CARP VIP (anything with a static IPv4 — DHCP/PPPoE interfaces are skipped), and calls out anything already partially configured for HA.
3. Fill in the secondary's real IPs, the shared CARP VIP per interface, and the dedicated SYNC interface (Heart's standard: a direct firewall-to-firewall connection, no default gateway).
4. Review the config-sync (XMLRPC) sections and DHCP failover options.
5. Generate, review the summary and raw XML, download both files.

## What it generates

- **CARP virtual IPs** (`virtualip/vip`, `mode=carp`) for each selected interface, with VHIDs chosen to avoid colliding with anything already in the source config.
- **A dedicated SYNC interface** on both files (new `optN` entry), carrying pfsync and the XMLRPC config-sync channel.
- **`<hasync>`** (System > High Availability Sync): pfsync peer IP, config-sync target, and the section-level sync checkboxes (rules, NAT, aliases, virtual IPs, etc.) — configured one-directional (primary pushes to secondary; the secondary's "Synchronize Config to IP" is left blank), matching pfSense's own recommendation.
- **DHCP failover** (`dhcpd/<iface>/failover_peerip`) for ISC-backend interfaces with DHCP enabled, per Heart's standard that DHCP stays on the firewall (see `~/second-brain/team/pfsense-configuration-standard.md`).

## Why the secondary's CARP advskew is fixed at +100, not editable

Verified against pfSense's own config-sync engine (`rc.filter_synchronize` in the pfSense source): when the primary pushes its config to the secondary via XMLRPC, it automatically adds 100 to every CARP VIP's `advskew` (capped at 254) in the copy it sends. Rather than generate a secondary file that's only correct *after* the first sync, this tool bakes in the post-sync value up front — set the primary's skew (default 0, advanced section), and the secondary is always skew+100. The same source confirms `failover_peerip` gets rewritten to the sender's own IP on each sync, which is why the DHCP failover fields this tool sets already match what pfSense would converge to on its own.

## Deliberately out of scope (v1)

- **Kea DHCP.** If the uploaded config's `dhcpbackend` is `kea`, the tool detects it and skips DHCP failover generation entirely rather than guessing at Kea's hot-standby/mTLS HA config, which is structurally different from the classic ISC `failover_peerip` mechanism and not compatible between backends (same finding as Heart's pfSense standard doc, Section 3). Flagged in the UI with a link to Netgate's docs.
- **IPsec, OpenVPN, certificates.** Carried through to the secondary unchanged (not modified, not omitted). The tool flags their presence so you know to review whether anything there is endpoint-specific — it does not guess at what should change.
- **Reusing an existing unused interface as SYNC.** The tool always creates a new dedicated interface, matching Heart's stated build convention. It doesn't offer repurposing an already-defined interface.

## Test fixtures

`test-fixtures/sample-config.xml` is synthetic (fake IPs, fake hostnames, no real credentials) — safe to commit and safe to open. Never replace it with a real backup; real config.xml files are gitignored by default (see `.gitignore`).

## Testing against real hardware

Two Netgate units are available for this. Always: import the *secondary* file onto a factory-reset or otherwise non-production unit first — never onto a box already carrying live traffic. Review the *primary* file's diff before reapplying it to the live primary.
