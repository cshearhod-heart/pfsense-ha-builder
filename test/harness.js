'use strict';
// Loads pfsense-ha-builder.html in headless Chromium, feeds it a fixture, applies optional form
// tweaks, clicks Generate, and returns everything a test needs to assert on. No network access.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const PAGE_URL = 'file://' + path.join(REPO, 'pfsense-ha-builder.html');
const OUT_DIR = path.join(__dirname, 'out');

let browser = null;
async function getBrowser() { if (!browser) browser = await chromium.launch(); return browser; }
async function closeBrowser() { if (browser) { await browser.close(); browser = null; } }

// opts: { fixture: 'sample-config.xml', tweak: async (page) => {...}, name: 'label-for-output-files' }
async function generate(opts) {
  const page = await (await getBrowser()).newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(PAGE_URL);
  await page.setInputFiles('#fileInput', path.join(REPO, 'test-fixtures', opts.fixture));
  await page.waitForSelector('#step-form:not([hidden])');

  const formDefaults = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('#ifaceCards input, #ifaceCards select, #dhcpSection input')) {
      out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    for (const id of ['syncSource', 'syncIfPrimary', 'syncIfSecondary', 'syncBase', 'syncMaskBits', 'syncIpPrimary', 'syncIpSecondary', 'hasyncUser', 'hasyncPass', 'secHostname']) {
      const el = document.getElementById(id); out[id] = el ? el.value : undefined;
    }
    return out;
  });

  // Fill the fields the fixtures leave blank so the default path can generate.
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el && !el.disabled && !el.value) el.value = v; };
    set('hasyncPass', 'TestSyncPassword1');
    set('syncIfPrimary', 'igb9');
    set('syncIfSecondary', 'igb9');
  });
  if (opts.tweak) await opts.tweak(page);

  await page.click('#generateBtn');
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => ({
    validation: document.getElementById('validationErrors').innerText.trim(),
    outputShown: !document.getElementById('step-output').hidden,
    warningsText: document.getElementById('outputWarnings').innerText,
    primaryCardTitle: document.getElementById('primaryCardTitle').textContent,
    primaryXml: (typeof lastResult !== 'undefined' && lastResult) ? lastResult.primaryXml : null,
    secondaryXml: (typeof lastResult !== 'undefined' && lastResult) ? lastResult.secondaryXml : null,
    syncKey: (typeof lastResult !== 'undefined' && lastResult) ? lastResult.syncKey : null,
  }));
  await page.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = opts.name || opts.fixture.replace(/\.xml$/, '');
  if (result.primaryXml) {
    fs.writeFileSync(path.join(OUT_DIR, `${name}-primary.xml`), result.primaryXml);
    fs.writeFileSync(path.join(OUT_DIR, `${name}-secondary.xml`), result.secondaryXml);
  }
  return { ...result, formDefaults, pageErrors };
}

// Tiny XML query helpers for assertions (Node has no DOMParser; use regex on the generated text,
// which is fine because the generator's output is machine-serialized and predictable).
function section(xml, openTag, closeTag) {
  const i = xml.indexOf(openTag); if (i < 0) return '';
  const j = xml.indexOf(closeTag, i); return j < 0 ? '' : xml.slice(i, j + closeTag.length);
}
function texts(xml, tag) {
  return Array.from(xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))).map(m => m[1]);
}
function text(xml, tag) { const t = texts(xml, tag); return t.length ? t[0] : null; }

module.exports = { generate, closeBrowser, section, texts, text };
