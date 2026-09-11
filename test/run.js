'use strict';
const assert = require('node:assert/strict');
const { generate, closeBrowser, section, texts, text } = require('./harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- baseline: all three fixtures generate without page errors ----------
for (const fixture of ['sample-config.xml', 'sample-config-existing-ha.xml', 'sample-config-kea-existing-ha.xml']) {
  test(`${fixture}: default path generates with no page errors`, async () => {
    const r = await generate({ fixture });
    assert.deepEqual(r.pageErrors, []);
    assert.equal(r.validation, '');
    assert.ok(r.outputShown, 'output section should be visible');
    assert.ok(r.primaryXml.startsWith('<?xml'), 'primary should carry the XML declaration');
    assert.ok(r.secondaryXml.includes('<hostname>'), 'secondary should be a full config');
  });
}

test('existing-ha: primary output leaves the existing VIP untouched', async () => {
  const r = await generate({ fixture: 'sample-config-existing-ha.xml' });
  const vips = section(r.primaryXml, '<virtualip>', '</virtualip>');
  const lanVip = vips.split('<vip>').find(v => v.includes('<interface>lan</interface>'));
  assert.equal(text(lanVip, 'advskew'), '0');
  assert.equal(text(lanVip, 'vhid'), '7');
  assert.equal(text(lanVip, 'uniqid'), 'abc123def456');
});

test('kea-existing-ha: primary is reported as unchanged, secondary has a flipped HA block', async () => {
  const r = await generate({ fixture: 'sample-config-kea-existing-ha.xml' });
  assert.equal(r.primaryCardTitle, 'Primary — no changes needed');
  const ha = section(r.secondaryXml, '<ha>', '</ha>');
  assert.equal(text(ha, 'role'), 'standby');
  assert.equal(text(ha, 'localip'), '10.255.255.2');
  assert.equal(text(ha, 'remoteip'), '10.255.255.1');
  assert.equal(text(ha, 'remotename'), 'fw-kea-ha');
});

// ---------- later tasks append their tests below this line ----------

test('task1: WAN suggestion skips the ISP gateway and validation rejects it', async () => {
  const r = await generate({ fixture: 'sample-config.xml' });
  assert.equal(r.formDefaults.pip_wan, '203.0.113.11', 'primary new IP must skip .9 (gateway) and .10 (current)');
  assert.equal(r.formDefaults.sip_wan, '203.0.113.12');
  const wan = section(r.primaryXml, '<wan>', '</wan>');
  assert.notEqual(text(wan, 'ipaddr'), '203.0.113.9');

  const r2 = await generate({ fixture: 'sample-config.xml', name: 'task1-typed-gateway', tweak: async page => {
    await page.fill('#pip_wan', '203.0.113.9');
  }});
  assert.match(r2.validation, /203\.0\.113\.9 is already in use/);
  assert.equal(r2.outputShown, false);
});

test('task2: both files get a pass rule on the SYNC interface; adopt path adds none', async () => {
  const r = await generate({ fixture: 'sample-config.xml' });
  for (const xml of [r.primaryXml, r.secondaryXml]) {
    const rules = section(xml, '<filter>', '</filter>').split('<rule>').filter(x => x.includes('</rule>'));
    const syncRules = rules.filter(x => text(x, 'interface') === r.syncKey);
    assert.equal(syncRules.length, 1, 'exactly one generated rule on the SYNC interface');
    assert.equal(text(syncRules[0], 'type'), 'pass');
    assert.equal(text(section(syncRules[0], '<source>', '</source>'), 'network'), r.syncKey);
    assert.ok(section(syncRules[0], '<destination>', '</destination>').includes('<any/>'), 'destination any');
    assert.match(text(syncRules[0], 'tracker'), /^\d{10}$/);
  }
  assert.match(r.warningsText, /pass rule from SYNC net/);

  const adopted = await generate({ fixture: 'sample-config-existing-ha.xml' });
  assert.equal(adopted.primaryXml.includes('HA: pass from SYNC net'), false, 'live SYNC interface must not be touched');
  assert.equal(adopted.secondaryXml.includes('HA: pass from SYNC net'), false);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   - ${t.name}`); }
    catch (e) { failed++; console.log(`FAIL - ${t.name}\n       ${e.message.split('\n').join('\n       ')}`); }
  }
  await closeBrowser();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
