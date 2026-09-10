import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CALLBACK_PATH,
  CLOCK_SKEW_SECONDS,
  MICROSOFT_LOGIN_HOST,
  SSO_ERROR_PARAM,
  authorizeUrl,
  callbackRedirect,
  claimsProblem,
  discoveryUrl,
  emailDomain,
  emailFromClaims,
  entraConfigured,
  entraProblem,
  isSingleTenant,
  mfaSatisfied,
  nameFromClaims,
  provisioningProblem,
  redirectUri,
  type IdTokenClaims,
} from './index';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '99999999-8888-7777-6666-555555555555';
const NOW = 1_760_000_000;

const goodClaims = (over: Partial<IdTokenClaims> = {}): IdTokenClaims => ({
  iss: `${MICROSOFT_LOGIN_HOST}/${TENANT}/v2.0`,
  aud: CLIENT,
  tid: TENANT,
  oid: 'abc-oid',
  sub: 'abc-sub',
  exp: NOW + 3600,
  iat: NOW - 10,
  nbf: NOW - 10,
  nonce: 'nonce-value',
  preferred_username: 'Joe@SupportWizard.net',
  name: 'Joe Kane',
  ...over,
});

const check = { clientId: CLIENT, tenantId: TENANT, nonce: 'nonce-value', now: NOW };

/* ---- Configuration ------------------------------------------------ */

test('an empty configuration says it is not set up, not what is missing', () => {
  assert.equal(entraProblem(undefined), 'Microsoft sign-in is not set up.');
  assert.equal(entraProblem({ tenantId: '', clientId: '', clientSecret: '' }), 'Microsoft sign-in is not set up.');
  assert.equal(entraConfigured({}), false);
});

test('a half-filled configuration names the boxes that are still empty', () => {
  const problem = entraProblem({ tenantId: TENANT, clientId: '', clientSecret: '' });
  assert.ok(problem?.includes('application (client) ID'), String(problem));
  assert.ok(problem?.includes('client secret'), String(problem));
  assert.ok(problem?.includes('are'), 'two missing things take a plural verb');

  const one = entraProblem({ tenantId: TENANT, clientId: CLIENT, clientSecret: '' });
  assert.ok(one?.includes('client secret'), String(one));
  assert.ok(one?.includes(' is still missing'), String(one));
});

test('a complete configuration has nothing to report', () => {
  assert.equal(entraProblem({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'shh' }), undefined);
  assert.equal(entraConfigured({ tenantId: TENANT, clientId: CLIENT, clientSecret: 'shh' }), true);
});

test('whitespace does not count as a filled-in box', () => {
  assert.ok(entraProblem({ tenantId: TENANT, clientId: CLIENT, clientSecret: '   ' }));
});

test('the multi-tenant aliases are not one directory', () => {
  for (const alias of ['common', 'organizations', 'consumers', 'COMMON', ' Common ']) {
    assert.equal(isSingleTenant(alias), false, alias);
  }
  assert.equal(isSingleTenant(TENANT), true);
  assert.equal(isSingleTenant('supportwizard.net'), true);
  assert.equal(isSingleTenant(''), false);
});

test('the discovery URL names the tenant and the v2 endpoint', () => {
  assert.equal(discoveryUrl(TENANT), `${MICROSOFT_LOGIN_HOST}/${TENANT}/v2.0/.well-known/openid-configuration`);
});

test('the redirect URI is the portal root plus the callback path, with no doubled slash', () => {
  assert.equal(redirectUri('https://comms.supportwizard.net/'), `https://comms.supportwizard.net${CALLBACK_PATH}`);
  assert.equal(redirectUri('https://comms.supportwizard.net'), `https://comms.supportwizard.net${CALLBACK_PATH}`);
});

/* ---- The authorization request ------------------------------------ */

test('the authorization URL carries PKCE, state and nonce, and asks for nothing extra', () => {
  const url = new URL(
    authorizeUrl({
      authorizationEndpoint: `${MICROSOFT_LOGIN_HOST}/${TENANT}/oauth2/v2.0/authorize`,
      clientId: CLIENT,
      redirectUri: `https://comms.supportwizard.net${CALLBACK_PATH}`,
      state: 'state-value',
      nonce: 'nonce-value',
      codeChallenge: 'challenge-value',
    }),
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('nonce'), 'nonce-value');
  assert.equal(url.searchParams.get('scope'), 'openid profile email');
  // No directory, mail or file scope is ever requested.
  // Anchored on the Graph scope shapes rather than bare words: "email" is a
  // scope we do ask for, and it contains "mail".
  assert.ok(!/Mail\.|User\.Read|Files\.|Directory\./i.test(url.searchParams.get('scope') ?? ''));
  assert.equal(url.searchParams.get('login_hint'), null);
  assert.equal(url.searchParams.get('prompt'), null);
});

test('a login hint and a prompt are added only when asked for', () => {
  const url = new URL(
    authorizeUrl({
      authorizationEndpoint: `${MICROSOFT_LOGIN_HOST}/${TENANT}/oauth2/v2.0/authorize`,
      clientId: CLIENT,
      redirectUri: 'https://x/y',
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
      loginHint: 'joe@supportwizard.net',
      prompt: 'select_account',
    }),
  );
  assert.equal(url.searchParams.get('login_hint'), 'joe@supportwizard.net');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

/* ---- Claim validation --------------------------------------------- */

test('a well-formed token from the configured tenant passes', () => {
  assert.equal(claimsProblem(goodClaims(), check), undefined);
});

test('a token for another application is refused', () => {
  const problem = claimsProblem(goodClaims({ aud: 'some-other-app' }), check);
  assert.ok(problem?.includes('different application'), String(problem));
});

test('an audience array is accepted when it contains our client id', () => {
  assert.equal(claimsProblem(goodClaims({ aud: ['other', CLIENT] }), check), undefined);
  assert.ok(claimsProblem(goodClaims({ aud: ['other'] }), check));
});

test('a token from a different directory is refused, by issuer and by tid', () => {
  const otherTenant = '00000000-0000-0000-0000-000000000000';
  assert.ok(
    claimsProblem(goodClaims({ iss: `${MICROSOFT_LOGIN_HOST}/${otherTenant}/v2.0` }), check)?.includes(
      'different Microsoft directory',
    ),
  );
  // The issuer is right but the tid disagrees with it — refuse rather than
  // pick a winner.
  assert.ok(claimsProblem(goodClaims({ tid: otherTenant }), check));
});

test('an issuer that is not Microsoft at all is refused even on a multi-tenant registration', () => {
  const multi = { ...check, tenantId: 'common' };
  assert.ok(claimsProblem(goodClaims({ iss: 'https://evil.example/v2.0' }), multi)?.includes('did not come from Microsoft'));
  // Any Microsoft tenant is acceptable when the registration says "common".
  assert.equal(
    claimsProblem(goodClaims({ iss: `${MICROSOFT_LOGIN_HOST}/anything/v2.0`, tid: 'anything' }), multi),
    undefined,
  );
});

test('an expired token is refused, but only beyond the allowed skew', () => {
  assert.equal(claimsProblem(goodClaims({ exp: NOW - CLOCK_SKEW_SECONDS + 5 }), check), undefined);
  assert.ok(claimsProblem(goodClaims({ exp: NOW - CLOCK_SKEW_SECONDS - 5 }), check)?.includes('expired'));
  assert.ok(claimsProblem(goodClaims({ exp: undefined }), check));
});

test('a token not yet valid is refused, and the message points at the clock', () => {
  const problem = claimsProblem(goodClaims({ nbf: NOW + CLOCK_SKEW_SECONDS + 60 }), check);
  assert.ok(problem?.includes('server clock'), String(problem));
  // Inside the skew is fine.
  assert.equal(claimsProblem(goodClaims({ nbf: NOW + 30 }), check), undefined);
});

test('a replayed token with the wrong nonce is refused', () => {
  assert.ok(claimsProblem(goodClaims({ nonce: 'someone-elses' }), check)?.includes('this browser started'));
  assert.ok(claimsProblem(goodClaims({ nonce: undefined }), check));
});

test('a token naming no user is refused', () => {
  assert.ok(claimsProblem(goodClaims({ oid: undefined, sub: undefined }), check)?.includes('names no user'));
  // Either one is enough.
  assert.equal(claimsProblem(goodClaims({ oid: undefined }), check), undefined);
  assert.equal(claimsProblem(goodClaims({ sub: undefined }), check), undefined);
});

test('no claims at all is a problem, not a crash', () => {
  assert.ok(claimsProblem(undefined, check));
});

/* ---- Reading the identity ----------------------------------------- */

test('the email comes from preferred_username first, and is lower-cased', () => {
  assert.equal(emailFromClaims(goodClaims()), 'joe@supportwizard.net');
  assert.equal(
    emailFromClaims({ email: 'from-email@supportwizard.net', upn: 'from-upn@supportwizard.net' }),
    'from-email@supportwizard.net',
  );
  assert.equal(emailFromClaims({ upn: 'from-upn@supportwizard.net' }), 'from-upn@supportwizard.net');
});

test('a preferred_username that is not an email address is skipped, not used', () => {
  // Entra puts things like `live.com#joe@example.com` and bare sign-in names
  // in here for some account types.
  assert.equal(
    emailFromClaims({ preferred_username: 'live.com#joe@example.com', email: 'joe@supportwizard.net' }),
    'joe@supportwizard.net',
  );
  assert.equal(emailFromClaims({ preferred_username: 'JOEK' }), undefined);
  assert.equal(emailFromClaims(undefined), undefined);
});

test('the display name falls back through the parts to the email local part', () => {
  assert.equal(nameFromClaims(goodClaims()), 'Joe Kane');
  assert.equal(nameFromClaims({ given_name: 'Joe', family_name: 'Kane' }), 'Joe Kane');
  assert.equal(nameFromClaims({ given_name: 'Joe' }), 'Joe');
  assert.equal(nameFromClaims({}, 'joe.kane@supportwizard.net'), 'Joe Kane');
  assert.equal(nameFromClaims({}), 'Microsoft user');
});

test('mfa is read from amr and nowhere else', () => {
  assert.equal(mfaSatisfied(goodClaims({ amr: ['pwd', 'mfa'] })), true);
  assert.equal(mfaSatisfied(goodClaims({ amr: ['MFA'] })), true);
  assert.equal(mfaSatisfied(goodClaims({ amr: ['pwd'] })), false);
  assert.equal(mfaSatisfied(goodClaims()), false);
  assert.equal(mfaSatisfied(undefined), false);
});

test('emailDomain takes the part after the at sign', () => {
  assert.equal(emailDomain('Joe@SupportWizard.NET'), 'supportwizard.net');
  assert.equal(emailDomain('nonsense'), '');
});

/* ---- Creating an account on first sign-in ------------------------- */

test('a single-tenant registration with no allow-list may create an account', () => {
  assert.equal(provisioningProblem('joe@supportwizard.net', { tenantId: TENANT, allowedDomains: [] }), undefined);
});

test('a multi-tenant registration may never create an account', () => {
  const problem = provisioningProblem('joe@supportwizard.net', { tenantId: 'common', allowedDomains: [] });
  assert.ok(problem?.includes('one directory'), String(problem));
});

test('the domain allow-list is enforced, and tolerates a leading at sign', () => {
  const settings = { tenantId: TENANT, allowedDomains: ['@supportwizard.net', 'ClubWizard.co.uk'] };
  assert.equal(provisioningProblem('joe@supportwizard.net', settings), undefined);
  assert.equal(provisioningProblem('sam@clubwizard.co.uk', settings), undefined);
  const problem = provisioningProblem('guest@contoso.com', settings);
  assert.ok(problem?.includes('guest@contoso.com'), String(problem));
  assert.ok(problem?.includes('by hand'), 'says what an administrator can do instead');
});

test('no email address means no account can be created', () => {
  assert.ok(provisioningProblem(undefined, { tenantId: TENANT, allowedDomains: [] })?.includes('did not return an email address'));
});

/* ---- Carrying the outcome back ------------------------------------ */

test('a successful callback lands on the app root with no query', () => {
  assert.equal(callbackRedirect(), '/');
});

test('a failed callback carries the message in one encoded parameter', () => {
  const to = callbackRedirect('That account has no NetKit account.');
  assert.ok(to.startsWith(`/?${SSO_ERROR_PARAM}=`));
  const value = new URL(to, 'https://x').searchParams.get(SSO_ERROR_PARAM);
  assert.equal(value, 'That account has no NetKit account.');
});
