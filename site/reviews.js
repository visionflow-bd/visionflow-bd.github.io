(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VFReviews = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';

  // Public testimonial status requires a client-originated event and evidence.
  function isConsentVerified(review) {
    if (!review || review.publicationStatus !== 'consent-verified') return false;
    if (review.sourceType !== 'client-submission') return false;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(review.consentEvidenceId || ''))) return false;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(review.sourceEventId || ''))) return false;
    return Number.isFinite(Date.parse(String(review.consentedAt || '')));
  }

  function disclosure(review) {
    return isConsentVerified(review)
      ? { verified: true, label: 'Client-consented testimonial' }
      : { verified: false, label: 'Example review - client consent not verified' };
  }

  function filterPublicReviews(reviews) {
    return Array.isArray(reviews) ? reviews.filter(isConsentVerified) : [];
  }

  return { isConsentVerified, disclosure, filterPublicReviews };
});
