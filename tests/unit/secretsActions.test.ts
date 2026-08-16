import { describe, expect, it } from 'vitest';
import { evaluateProtectedAction, evaluateSecretField, isProtectedEndpoint } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';

describe('secret field detection (§19.3)', () => {
  it('blocks password input types', () => {
    expect(evaluateSecretField({ inputType: 'password' }).blocked).toBe(true);
    expect(evaluateSecretField({ inputType: 'PASSWORD' }).blocked).toBe(true);
  });

  it.each(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-exp', 'cc-csc'])(
    'blocks autocomplete token %s',
    (token) => {
      expect(evaluateSecretField({ inputType: 'text', autocomplete: token }, ebaySiteProfile).blocked).toBe(true);
    },
  );

  it('blocks multi-token autocomplete values', () => {
    expect(evaluateSecretField({ inputType: 'text', autocomplete: 'section-blue shipping cc-number' }).blocked).toBe(true);
  });

  it('blocks editable fields inside recognized sensitive forms', () => {
    expect(
      evaluateSecretField({ inputType: 'text', formSignals: '/account/signin login-form' }).blocked,
    ).toBe(true);
    expect(
      evaluateSecretField({ inputType: 'text', formSignals: '/checkout/payment billing' }).blocked,
    ).toBe(true);
  });

  it('allows ordinary search/postal fields', () => {
    expect(evaluateSecretField({ inputType: 'text', name: 'q', formSignals: '/sch/search-form' }).blocked).toBe(false);
    expect(evaluateSecretField({ inputType: 'text', name: 'zipCode', ariaLabel: 'Postal code' }).blocked).toBe(false);
  });
});

describe('protected actions (§19.2, Appendix C)', () => {
  const corpus = [
    'Buy It Now',
    'buy  it   now',
    'Confirm and pay',
    'Place bid',
    'Submit bid',
    'Make offer',
    'Send offer',
    'Message seller',
    'Send message',
    'Change password',
    'Security settings',
    'Add to cart',
    'Add to Watchlist',
  ];
  it.each(corpus)('blocks "%s"', (name) => {
    const decision = evaluateProtectedAction(
      { accessibleName: name, role: 'button', pageUrl: 'https://www.ebay.ca/itm/1' },
      ebaySiteProfile,
    );
    expect(decision.blocked).toBe(true);
  });

  it('allows reversible research controls', () => {
    for (const name of ['Change shipping destination', 'Next image', 'See full description', 'Theme assortment']) {
      expect(
        evaluateProtectedAction({ accessibleName: name, role: 'button', pageUrl: 'https://www.ebay.ca/itm/1' }, ebaySiteProfile)
          .blocked,
      ).toBe(false);
    }
  });

  it('blocks by href/form action endpoint patterns', () => {
    const decision = evaluateProtectedAction(
      {
        accessibleName: 'Continue',
        role: 'link',
        href: 'https://pay.ebay.ca/rxo?action=create',
        pageUrl: 'https://www.ebay.ca/itm/1',
      },
      ebaySiteProfile,
    );
    expect(decision.blocked).toBe(true);
  });

  it('network layer flags transaction endpoints (§19.2 defense-in-depth)', () => {
    const blocked = [
      'https://www.ebay.ca/rxo?action=create&item=1',
      'https://pay.ebay.ca/anything',
      'https://www.ebay.ca/bfl/bidflow/1?bid=5',
      'https://offer.ebay.ca/ws/bestoffer/submit',
      'https://cart.ebay.ca/api/add?item=1',
      'https://www.ebay.ca/cnt/contact_seller?item=1',
      'https://signin.ebay.ca/ws/SignInSubmit',
      'https://www.ebay.ca/myb/watchlist/api/add?item=1',
    ];
    for (const url of blocked) {
      expect(isProtectedEndpoint(url, ebaySiteProfile), url).toBe(true);
    }
    const allowed = [
      'https://www.ebay.ca/itm/123456789012',
      'https://www.ebay.ca/sch/i.html?_nkw=lego',
      'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
      'https://www.ebay.ca/str/brickdeals',
    ];
    for (const url of allowed) {
      expect(isProtectedEndpoint(url, ebaySiteProfile), url).toBe(false);
    }
  });
});
