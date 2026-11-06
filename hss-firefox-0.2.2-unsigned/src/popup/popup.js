import { matchesAny, normalizeDomain } from '../background/proxy-rules.js';

const $ = (id) => document.getElementById(id);
let state = null;
let busy = false;
let locationsKey = '';
let formOpen = false; // sign-in form visibility (UI-only state)

async function send(message) {
  const res = await browser.runtime.sendMessage(message);
  if (res?.state) state = res.state;
  return res;
}

function locationLabel(loc) {
  const country = loc.description?.split('-')[0]?.trim() || loc.labels?.country || loc.name;
  const city = loc.labels?.city;
  return city && city !== country ? `${country}, ${city}` : country;
}

function currentLocationName() {
  if (!state || state.location === 'optimal') return 'the best location';
  const loc = state.locations.find((l) => l.name === state.location);
  return loc ? locationLabel(loc) : state.location;
}

function viewState() {
  if (state.status === 'connected') return 'connected';
  if (state.intent) return 'reconnecting'; // wants to be on, but the tunnel is not up
  return 'off';
}

function renderHero() {
  const view = viewState();
  document.body.dataset.state = view;
  let headline = 'Not protected';
  let detail = 'Browser traffic is going direct.';
  let button = 'Connect';

  if (view === 'connected') {
    headline = 'Protected';
    detail = `Browser traffic is going through ${currentLocationName()}.`;
    button = 'Disconnect';
  } else if (view === 'reconnecting') {
    headline = 'Reconnecting';
    detail = (state.blockWhenDown ? 'Traffic is blocked until the VPN is back. ' : 'Traffic is going direct. ') + (state.error ?? '');
    button = 'Disconnect';
  } else if (state.status === 'connecting') {
    headline = 'Connecting…';
    detail = `Contacting Hotspot Shield for ${currentLocationName()}.`;
  } else if (state.error) {
    detail = `Couldn’t connect: ${state.error}`;
  }
  if (state.status === 'disconnecting') headline = 'Disconnecting…';

  $('headline').textContent = headline;
  $('detail').textContent = detail.trim();
  $('toggle').textContent = button;
  $('toggle').disabled = busy || state.status === 'connecting' || state.status === 'disconnecting';
}

function renderLocations() {
  const select = $('location');
  // Include each location's status: signing in/out flips locations between 'premium' and 'ok'
  // without changing their names, and the list must be rebuilt when that happens.
  const key = JSON.stringify([state.locations.map((l) => [l.name, l.status]), state.location]);
  if (key === locationsKey) return;
  locationsKey = key;

  const sorted = [...state.locations].sort((a, b) => {
    const ok = (l) => String(l.status).toLowerCase() === 'ok';
    return ok(b) - ok(a) || locationLabel(a).localeCompare(locationLabel(b));
  });
  select.replaceChildren(new Option('Best location', 'optimal'));
  for (const loc of sorted) {
    const allowed = String(loc.status).toLowerCase() === 'ok';
    const option = new Option(allowed ? locationLabel(loc) : `${locationLabel(loc)} (Elite only)`, loc.name);
    option.disabled = !allowed;
    select.append(option);
  }
  select.value = state.location;
  if (select.value !== state.location) select.value = 'optimal';
}

function renderAccount() {
  const acc = state.account ?? { authorized: false };
  $('accountIn').hidden = !acc.authorized;
  $('accountOut').hidden = acc.authorized;

  if (acc.authorized) {
    formOpen = false;
    $('signInForm').hidden = true;
    $('accountLogin').textContent = acc.login;
    const plan = acc.elite ? 'Elite plan' : 'Free plan';
    const known = acc.devicesMax && acc.devicesUsed !== undefined;
    const devices = known ? `, ${acc.devicesUsed} of ${acc.devicesMax} devices in use` : '';
    $('accountPlan').textContent = plan + devices;
    return;
  }
  $('accountNotice').hidden = !acc.notice;
  $('accountNotice').textContent = acc.notice ?? '';
  $('accountHint').hidden = formOpen;
  $('showSignIn').hidden = formOpen;
  $('signInForm').hidden = !formOpen;
}

function renderSite() {
  const domain = state.activeDomain ? normalizeDomain(state.activeDomain) : '';
  $('site').hidden = !domain;
  if (!domain) return;
  $('siteName').textContent = domain;
  $('bypass').checked = matchesAny(domain, state.bypass);
  $('secured').checked = matchesAny(domain, state.secured);
}

function renderNotices() {
  const notes = [];
  if (state.incognitoAllowed === false) {
    notes.push('Private windows are not covered. Allow this extension to run in private windows in the Add-ons Manager.');
  }
  if (state.privacyWarning) notes.push(`WebRTC protection could not be applied: ${state.privacyWarning}`);
  $('notice').hidden = notes.length === 0;
  $('notice').textContent = notes.join(' ');
}

function renderDiagnostics() {
  const d = state.diagnostics ?? {};
  const info = {
    version: d.version,
    tracksUpstream: d.upstreamVersion,
    device: d.deviceHash,
    pangoSession: d.pangoAuthed,
    servers: state.serverCount,
    credentialsExpire: state.credentialsExpire ? new Date(state.credentialsExpire).toISOString() : null,
    eliteError: d.eliteError,
    pangoError: d.pangoError,
    lastProxyError: state.lastProxyError,
    error: state.error,
  };
  $('diag').textContent = JSON.stringify(info, null, 2);
}

function render() {
  if (!state) return;
  renderHero();
  renderLocations();
  renderAccount();
  renderSite();
  renderNotices();
  $('webrtc').checked = state.webrtcProtection;
  $('blockWhenDown').checked = state.blockWhenDown;
  renderDiagnostics();
}

async function act(message) {
  busy = true;
  render();
  try {
    await send(message);
  } finally {
    busy = false;
    render();
  }
}

$('toggle').addEventListener('click', () => {
  const on = state.status === 'connected' || state.intent;
  act(on ? { type: 'disconnect' } : { type: 'connect', location: $('location').value });
});
$('location').addEventListener('change', (e) => act({ type: 'setLocation', location: e.target.value }));
$('bypass').addEventListener('change', (e) => act({ type: 'setBypass', domain: state.activeDomain, on: e.target.checked }));
$('secured').addEventListener('change', (e) => act({ type: 'setSecured', domain: state.activeDomain, on: e.target.checked }));
$('webrtc').addEventListener('change', (e) => act({ type: 'setOption', key: 'webrtcProtection', value: e.target.checked }));
$('blockWhenDown').addEventListener('change', (e) => act({ type: 'setOption', key: 'blockWhenDown', value: e.target.checked }));

function setSigningIn(on) {
  for (const id of ['email', 'password', 'submitSignIn', 'cancelSignIn']) $(id).disabled = on;
  $('submitSignIn').textContent = on ? 'Signing in…' : 'Sign in';
}

function showSignInError(message) {
  $('signInError').hidden = !message;
  $('signInError').textContent = message ?? '';
}

$('showSignIn').addEventListener('click', () => {
  formOpen = true;
  render();
  $('email').focus();
});

$('cancelSignIn').addEventListener('click', () => {
  formOpen = false;
  $('email').value = '';
  $('password').value = '';
  showSignInError(null);
  render();
});

$('signInForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const login = $('email').value;
  const password = $('password').value;
  $('password').value = ''; // the password lives in the DOM only until it is sent
  showSignInError(null);
  busy = true;
  setSigningIn(true);
  render();
  try {
    const res = await send({ type: 'signIn', login, password });
    if (res.ok) {
      formOpen = false;
      $('email').value = '';
    } else {
      showSignInError(res.error);
    }
  } finally {
    busy = false;
    setSigningIn(false);
    render();
  }
});

$('signOut').addEventListener('click', () => act({ type: 'signOut' }));

// Background pushes {type:'changed'} whenever status or settings change.
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'changed' && !busy) send({ type: 'getState' }).then(render);
});

(async () => {
  await send({ type: 'getState' });
  render();
  if (state?.locationsStale) {
    await send({ type: 'refreshLocations' }); // may hit the network; the popup is already usable
    render();
  }
})();
