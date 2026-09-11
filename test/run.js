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
