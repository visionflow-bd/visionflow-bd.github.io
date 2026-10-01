const { test } = require('node:test');
const assert = require('node:assert/strict');
const reviews = require('../site/reviews.js');

test('public reviews require client-originated consent evidence', () => {
  assert.equal(reviews.isConsentVerified({ publicationStatus: 'consent-verified' }), false);
  assert.equal(reviews.disclosure({}).label, 'Example review - client consent not verified');

  const adminOnly = {
    publicationStatus: 'consent-verified',
    sourceType: 'admin',
    consentEvidenceId: 'consent-1',
    sourceEventId: 'event-1',
    consentedAt: '2026-10-01T00:00:00.000Z'
  };
  assert.equal(reviews.isConsentVerified(adminOnly), false);

  const verified = { ...adminOnly, sourceType: 'client-submission' };
  assert.equal(reviews.isConsentVerified(verified), true);
  assert.deepEqual(reviews.disclosure(verified), {
    verified: true,
    label: 'Client-consented testimonial'
  });
});

test('malformed evidence is not treated as consent', () => {
  const base = {
    publicationStatus: 'consent-verified',
    sourceType: 'client-submission',
    consentEvidenceId: 'consent-1',
    sourceEventId: 'event-1'
  };
  assert.equal(reviews.isConsentVerified({ ...base, consentedAt: 'not-a-date' }), false);
  assert.equal(reviews.isConsentVerified({ ...base, consentedAt: '2026-10-01', sourceEventId: 'bad id' }), false);
});

test('unverified seeded/admin records never enter the public review list', () => {
  const verified = {
    publicationStatus: 'consent-verified',
    sourceType: 'client-submission',
    consentEvidenceId: 'consent-1',
    sourceEventId: 'event-1',
    consentedAt: '2026-10-01T00:00:00.000Z'
  };
  const publicReviews = reviews.filterPublicReviews([
    { id: 'seeded', sourceType: 'admin', text: 'Seeded text' },
    { id: 'verified', ...verified }
  ]);
  assert.deepEqual(publicReviews.map(review => review.id), ['verified']);
});
