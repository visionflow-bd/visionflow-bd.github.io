import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClient, publicSnapshot, deliveryColumns } from '../portal/data.js';
import { buildProjectReport, buildProjectAgreement } from '../portal/report.js';

const project = overrides => ({
  name: 'Generic campaign',
  rate: 100,
  budget: 100,
  status: 'active',
  items: [{ n: 1, b: 'Product A', t: 'Launch reel', s: 'pending' }],
  payments: [],
  approvals: [],
  ...overrides,
});

const clientWith = overrides => normalizeClient({
  name: 'Label test client',
  projects: { campaign: project(overrides) },
}, 'label-test');

test('generic and blank project labels normalize to reusable defaults', () => {
  const generic = clientWith({});
  assert.equal(generic.projects.campaign.itemLabel, 'Item / subject');
  assert.equal(generic.projects.campaign.titleLabel, 'Deliverable title');
  assert.equal(generic.projects.campaign.showItemField, true);

  const blank = clientWith({ itemLabel: '   ', titleLabel: '', showItemField: false });
  assert.equal(blank.projects.campaign.itemLabel, 'Item / subject');
  assert.equal(blank.projects.campaign.titleLabel, 'Deliverable title');
  assert.equal(blank.projects.campaign.showItemField, false);
});

test('explicit K9 and other custom terminology survives normalization and public projection', () => {
  const dog = clientWith({
    name: 'K9 videos',
    itemLabel: 'Breed',
    titleLabel: 'Video title',
    showItemField: true,
  });
  const published = publicSnapshot(dog, 'label-test').projects.campaign;
  assert.equal(published.itemLabel, 'Breed');
  assert.equal(published.titleLabel, 'Video title');
  assert.equal(published.showItemField, true);

  const podcast = clientWith({ itemLabel: 'Guest / episode', titleLabel: 'Episode title' });
  const podcastPublic = publicSnapshot(podcast, 'label-test').projects.campaign;
  assert.equal(podcastPublic.itemLabel, 'Guest / episode');
  assert.equal(podcastPublic.titleLabel, 'Episode title');
});

test('report renders separate escaped custom labels instead of a dog-specific heading', () => {
  const client = clientWith({
    itemLabel: 'Product <type>',
    titleLabel: 'Creative & title',
    showItemField: true,
  });
  const report = buildProjectReport({ client, project: client.projects.campaign });
  assert.ok(report.includes('<th>Product &lt;type&gt;</th>'));
  assert.ok(report.includes('<th>Creative &amp; title</th>'));
  assert.ok(report.includes('<td>Product A</td>'));
  assert.ok(report.includes('Launch reel'));
  assert.ok(!report.includes('Breed / title'));
  assert.ok(!report.includes('<th>Breed'));
});

test('optional item field can be hidden without deleting its stored value', () => {
  const client = clientWith({
    itemLabel: 'Internal subject',
    titleLabel: 'Deliverable title',
    showItemField: false,
  });
  const normalized = client.projects.campaign;
  assert.equal(normalized.items[0].b, 'Product A');

  const published = publicSnapshot(client, 'label-test').projects.campaign;
  assert.equal(published.showItemField, false);
  assert.equal(published.items[0].b, 'Product A');

  const report = buildProjectReport({ client, project: normalized });
  assert.ok(report.includes('<th>Deliverable title</th>'));
  assert.ok(report.includes('Launch reel'));
  assert.ok(!report.includes('<th>Internal subject</th>'));
  assert.ok(!report.includes('<strong>Product A</strong>'));
});

test('delivery columns appear only after a field is populated, including each file type', () => {
  const client = clientWith({
    itemLabel: 'Product', titleLabel: 'Creative',
    items: [
      { n:1, b:'', t:'', s:'pending', dl:'https://example.com/final.mp4' },
      { n:2, b:'', t:'', s:'pending', scriptUrl:'https://example.com/script' },
    ],
  });
  const p = client.projects.campaign, columns = deliveryColumns(p);
  assert.deepEqual(columns.map(column=>column.key),['dl','scriptUrl']);
  const report = buildProjectReport({ client, project:p });
  assert.ok(report.includes('<th>Final delivery</th>'));
  assert.ok(report.includes('<th>Script</th>'));
  assert.ok(!report.includes('<th>Creative</th>'));
  assert.ok(!report.includes('<th>Character / avatar</th>'));
});

test('agreement is a labeled white-paper document with project particulars and captured terms version', () => {
  const client = clientWith({ scope:'A clear project scope', terms:'Pay after approval', milestoneText:'First cut' });
  const founder = { founderSignatureUrl:'https://res.cloudinary.com/demo/image/upload/signature.png', authorizedName:'Founder Name', authorizedTitle:'Founder & CEO' };
  const agreement = buildProjectAgreement({ client, project:client.projects.campaign, ...founder });
  for (const expected of ['PROJECT AGREEMENT','Project particulars','Scope / description','Project-specific payment & delivery terms','Terms and conditions','1. Project scope','Vision Flow']) assert.ok(agreement.includes(expected));
  assert.ok(agreement.includes('VF-2026-09'));
  assert.ok(agreement.includes(founder.founderSignatureUrl));
  assert.ok(agreement.includes('Founder Name'));
  const report = buildProjectReport({ client, project:client.projects.campaign, ...founder });
  assert.ok(report.includes('Vision Flow authorization'));
  assert.ok(report.includes(founder.founderSignatureUrl));
});
