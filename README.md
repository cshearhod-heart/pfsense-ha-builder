# pfSense HA / CARP Builder

Takes a config backup from a running pfSense firewall and generates a paired configuration for a CARP high-availability secondary: an updated file for the existing (primary) firewall, and a new file for the second physical unit.

## Browser tool

**Live, always latest: https://cshearhod-heart.github.io/pfsense-ha-builder/**

Or open `pfsense-ha-builder.html` directly in any browser — same tool, works offline too. Either way, nothing is uploaded anywhere: parsing, generation, and download all happen locally in the tab, including on the hosted page above (it's a static file; your config.xml never leaves your machine).

1. Export the primary's backup: Diagnostics > Backup & Restore > Download configuration as XML.
2. Upload it. The tool lists every interface, flags which ones can carry a CARP VIP (anything with a static IPv4 — DHCP/PPPoE interfaces are skipped), and calls out anything already partially configured for HA.
3. Fill in the secondary's real IPs, the shared CARP VIP per interface, and the dedicated SYNC interface (Heart's standard: a direct firewall-to-firewall connection, no default gateway).
4. Review the config-sync (XMLRPC) sections and DHCP failover options.
5. Generate, review the summary and raw XML, download both files.

## When the primary needs no changes at all

If everything selected (every CARP-eligible interface, the SYNC interface, `hasync`, Kea HA) already existed and was adopted as-is, the primary output ends up functionally identical to what you uploaded — only the revision timestamp/description differ. The tool detects this and relabels the download card "Primary — no changes needed" rather than leaving you to wonder whether there's something to import. Found via testing against a real, fully-HA'd customer config, where this is the common case, not an edge case.

## Primary already has HA configured

If the uploaded config already has a CARP VIP on an interface, or `hasync` already pointed at a live pfsync interface, that interface's card and the SYNC section adapt automatically — nothing already-live is re-derived or touched on the primary:

- **A per-interface existing VIP** shows a simplified card: no VIP-strategy choice, no VHID/password to set — those are adopted exactly as they already are. Only the secondary's real IP and physical port are asked for (pre-filled from the existing `failover_peerip` when one reveals what the secondary's address was already meant to be). The secondary gets a matching VIP with the same VHID/password/advbase and `advskew` = existing + 100, mirroring pfSense's own sync-engine transform exactly.
- **An already-active pfsync interface** (found via `hasync/pfsyncinterface` pointing at a real, non-spare interface) locks the whole SYNC section to that interface — physical port, base address, and mask all become read-only, and the secondary's IP is pre-filled from the primary's existing `pfsyncpeerip`/`synchronizetoip` if they're consistent.
- **HA Sync username/password/sections** get pre-filled from the existing `hasync` block rather than asked for fresh.
- Any *other* CARP-eligible interface without an existing VIP still gets the normal fresh-build flow — the two modes coexist per-interface, since real rollouts often add HA to one interface at a time.

## VIP strategy: reuse the current IP, or assign a new one

CARP only protects whatever address downstream devices actually point at. For each interface you choose between:

- **Current IP becomes the VIP (default/recommended).** Both firewalls get new real IPs; the address every downstream device, DHCP lease, and static route already uses keeps working unchanged, because it's now the floating one. This is Netgate's own standard HA pattern.
- **Keep the current IP on the primary; the VIP is a new address.** Simpler to reason about, but anything downstream still pointed at the current address gets *no* HA protection until it's manually repointed at the new VIP — the tool flags this in the output warnings per interface, but can't fix it for you.

When reusing the current IP, the tool also sets `dhcpd/<iface>/gateway` explicitly to the VIP on interfaces with DHCP enabled. Without this, pfSense falls back to handing out its own interface IP as the DHCP-issued default gateway (confirmed in `services.inc`) — which after the swap would be the *new, non-floating* address, quietly breaking failover for every DHCP client on that segment.

`dhcpd/<iface>/dnsserver` has exactly the same trap and gets the same treatment. In both the ISC and Kea code paths, `services.inc` emits `option domain-name-servers {$ifcfgip}` — the interface's own real IP — whenever `dnsserver` is empty and the DNS Resolver or Forwarder is enabled. After the swap that's the non-floating address again, so DHCP clients keep their gateway on failover but lose DNS. The override is only written where that fallback would actually fire: an interface with explicit DNS servers already set, or a firewall running neither Resolver nor Forwarder (system DNS is handed out instead), is left alone.

In "reuse" mode, the primary's new IP and the secondary's IP are pre-filled with the next two free host addresses in the subnet (e.g. current `.1` → suggests `.2`/`.3`), skipping the interface's own DHCP pool range if one exists so the suggestion can't collide with a live lease. Also skipped: every address the uploaded config already reserves on that interface — gateway addresses from `gateways/gateway_item`, existing virtual IPs of any mode, and DHCP static mappings. That last set matters more than it sounds. On a `/29` WAN the ISP's gateway is usually the first host address, which is exactly where a naive "next free host" suggestion lands — a firewall handed its own upstream gateway's address loses its default route on import. Both fields stay editable, and a hand-typed address in any of those reserved sets is rejected by validation rather than silently accepted.

The CARP group password is pre-filled with a random 16-character value (`crypto.getRandomValues()` — the browser's own CSPRNG, not fetched from anywhere) — reveal it with the password field's own eye icon, or replace it. Kept to 16 characters deliberately: FreeBSD's CARP key buffer (`CARP_KEY_LEN` in `sys/netinet/ip_carp.h`) is 20 bytes copied with `strlcpy`, so anything past 19 characters is silently truncated by the kernel with no error.

## Import both files close together

ISC DHCP failover has a deliberate fail-safe (confirmed against Netgate's own troubleshooting docs): if a server can't reach its failover peer at startup, it intentionally stops issuing *new* leases rather than risk a conflicting assignment. This is not a config error, and CARP/pfsync are completely unaffected — it's DHCP-specific. Bring both firewalls up close together, ideally with a fresh lease database on each (Netgate's own recommendation). If one side needs to serve DHCP standalone before the other is ready, clear its "Failover peer IP" field temporarily and re-add it once the peer is reachable.

## What it generates

- **CARP virtual IPs** (`virtualip/vip`, `mode=carp`) for each selected interface, with VHIDs chosen to avoid colliding with anything already in the source config.
- **A dedicated SYNC interface** on both files (new `optN` entry), carrying pfsync and the XMLRPC config-sync channel.
- **A pass rule on the SYNC interface** (`filter/rule`, source "SYNC net", destination any) in both files. A newly created interface has no rules at all, which means default deny. pfSense auto-passes `proto carp` and nothing else — `set skip on pfsync0` in `filter.inc` is the pfsync *pseudo*-interface, not the physical NIC — so without this rule the pair boots with CARP working and pfsync, config sync, and Kea HA all silently blocked. This matches Netgate's HA recipe, which calls an allow-all from the Sync network sufficient; tighten it to TCP 443 + pfsync + TCP 8765-8766 after import if your policy requires. Skipped entirely when the SYNC interface is already live on the primary — its existing rules are the customer's and are carried through untouched.
- **`<hasync>`** (System > High Availability Sync): pfsync peer IP, config-sync target, and the section-level sync checkboxes (rules, NAT, aliases, virtual IPs, etc.) — configured one-directional (primary pushes to secondary; the secondary's "Synchronize Config to IP" is left blank), matching pfSense's own recommendation.
- **DHCP failover** (`dhcpd/<iface>/failover_peerip`) for ISC-backend interfaces with DHCP enabled, per Heart's internal pfSense configuration standard, which keeps DHCP on the firewall.

## Why the secondary's CARP advskew is fixed at +100, not editable

Verified against pfSense's own config-sync engine (`rc.filter_synchronize` in the pfSense source): when the primary pushes its config to the secondary via XMLRPC, it automatically adds 100 to every CARP VIP's `advskew` (capped at 254) in the copy it sends. Rather than generate a secondary file that's only correct *after* the first sync, this tool bakes in the post-sync value up front. Neither side's skew is editable: a newly created VIP is 0 on the primary and 100 on the secondary, and an adopted VIP keeps whatever the primary already has with +100 on the secondary. The bump applies to *every* `mode=carp` VIP in the config, not just the ones whose interface you selected — an unbumped VIP would sit at equal skew on the same VHID as its partner, and that tie is broken by IP address, i.e. a coin flip over which node holds MASTER. The same source confirms `failover_peerip` gets rewritten to the sender's own IP on each sync, which is why the DHCP failover fields this tool sets already match what pfSense would converge to on its own.

## VLAN interfaces

If an interface's physical port is actually a VLAN pseudo-interface (e.g. `mvneta1.2`), the tool detects it against the config's `<vlans>` section and locks that field instead of letting it be typed like a real NIC name — the value is computed from a parent port + tag defined elsewhere, and editing it without also updating the matching `<vlans>` entry produces a dangling reference. On identical hardware the VLAN carries over correctly with no changes needed, since the whole `<vlans>` section clones unchanged to both generated files.

## SYNC link subnet: /24 through /31

The point-to-point subnet is a base address plus a mask dropdown (not a typed CIDR string — that was more error-prone than it needed to be). `/31` is available and gets RFC 3021 treatment: no network/broadcast address is reserved, so both addresses in the pair are directly usable, which is the whole point for a link that only ever has exactly two hosts. Default stays `/30` for continuity; `/31` is opt-in.

## SYNC interface: new vs. reuse existing

The SYNC section offers two sources: **create a new dedicated interface** (the default), or **reuse an existing interface already defined in the config but currently unused** (no `<ipaddr>` and not enabled — e.g. a spare `optN` slot freed up by moving something else onto a VLAN). On reuse, the primary's physical port is left untouched since it's already real hardware in the source config; only `descr`, `enable`, `ipaddr`, and `subnet` are set on it, and the secondary gets its own physical port field (defaults to the same port, editable for non-identical hardware).

## Kea DHCP HA

Kea's HA is a completely different mechanism from ISC's `failover_peerip` — a hot-standby control-plane relationship (`<kea><ha>`: `role` primary/standby, `localname`/`localip` vs `remotename`/`remoteip`, optional TLS), verified against pfSense's own Kea settings page and a working production config. It rides the same dedicated SYNC link this tool already builds for pfsync, so no separate IP scheme is needed.

- **Already configured** (existing `<kea><ha>` with no TLS): adopted as-is, exactly like existing CARP — the primary is never touched, and the secondary gets a matching block with `localip`/`remoteip` swapped and `role` flipped, mirroring pfSense's own config-sync transform (`rc.filter_synchronize`) precisely, including leaving `heartbeatdelay`/`maxresponsedelay`/`maxackdelay`/`maxunackedclients`/`maxrejectedleaseupdates` unchanged since pfSense's own sync engine doesn't touch those either.
- **Not yet configured** (`dhcpbackend` is `kea`, no existing `<kea><ha>`): offered as an opt-in checkbox, building a fresh plaintext (no TLS) HA pair on the SYNC link.
- **TLS or mutual TLS enabled**: skipped entirely and flagged clearly. `scertref`/`ccertref` are pfSense-internal certificate reference IDs that won't be valid on a new secondary — this tool won't guess at cert linkage. Configure that part by hand.

## Deliberately out of scope (v1)
- **IPsec, OpenVPN, certificates.** Carried through to the secondary unchanged (not modified, not omitted). The tool flags their presence so you know to review whether anything there is endpoint-specific — it does not guess at what should change.
- **Freeing up a physical port yourself** (e.g. moving an interface onto a VLAN to make room for SYNC) is on you to do first, on the real primary, before exporting the backup this tool reads. The tool doesn't restructure your interface layout — it only builds the HA pair from whatever layout is already in the file.
- **NAT.** Flagged, never rewritten. In "reuse" mode the interface's real address changes, and two things quietly stop pointing at the floating address as a result. Automatic outbound NAT translates to the *interface* address, so each node would egress from its own non-floating IP and states couldn't fail over — Netgate's HA guide requires Hybrid or Manual outbound NAT with the CARP VIP as the translation address. Separately, any NAT or firewall rule whose source or destination is the "*interface* address" macro (`<network>wanip</network>` and its v4/v6 variants) now means the non-floating IP. The output panel counts and names both; fixing them is a deliberate, reviewed change to make on the primary after import, and config sync carries it to the secondary.

## Test fixtures

All fixtures are synthetic (fake IPs, fake hostnames, no real credentials) — safe to commit and safe to open. Never replace one with a real backup; real config.xml files are gitignored by default (see `.gitignore`).

| Fixture | Exercises |
|---|---|
| `sample-config.xml` | Fresh build, no HA anywhere: a `/29` WAN whose gateway sits in the suggestion path, an ISC DHCP scope on LAN, a local resolver (`unbound`), automatic outbound NAT, and a port forward using the "WAN address" macro. |
| `sample-config-existing-ha.xml` | A primary already carrying a CARP VIP and a live `hasync`/pfsync interface — the adopt-as-is path, where nothing live may be touched. |
| `sample-config-multi-vip.xml` | The same, plus a second CARP VIP on the same interface — the case where bumping one VIP per interface isn't enough. |
| `sample-config-kea-existing-ha.xml` | CARP + `hasync` + Kea HA all present at once on the same SYNC link, with a `remotename` that differs from the generated secondary hostname. |

## Testing

The tool itself has no dependencies and never needs a build step — the test harness is dev-only tooling that drives the real page in headless Chromium.

```
npm install
npx playwright install chromium
npm test
```

## Testing against real hardware

Two Netgate units are available for this. Always: import the *secondary* file onto a factory-reset or otherwise non-production unit first — never onto a box already carrying live traffic. Review the *primary* file's diff before reapplying it to the live primary.
