// Small bits of interactivity. Every page still works without JavaScript;
// this file just makes things a little smoother.
document.addEventListener('DOMContentLoaded', () => {
  // Ask "are you sure?" before dangerous actions (forms or buttons with data-confirm).
  document.addEventListener('submit', (event) => {
    const button = event.submitter;
    if (button && button.hasAttribute('data-skip-confirm')) return;
    const message = (button && button.dataset.confirm) || event.target.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // "Print" buttons.
  document.querySelectorAll('[data-print]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });

  // "Copy" buttons put their text on the clipboard.
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        const original = button.textContent;
        button.textContent = 'Copied!';
        setTimeout(() => {
          button.textContent = original;
        }, 2000);
      } catch {
        window.prompt('Copy this:', button.dataset.copy);
      }
    });
  });

  // Filter dropdowns apply as soon as you pick something.
  document.querySelectorAll('[data-autosubmit]').forEach((field) => {
    field.addEventListener('change', () => field.form.submit());
  });

  // A "select all" checkbox ticks every checkbox with the matching name.
  document.querySelectorAll('[data-select-all]').forEach((master) => {
    master.addEventListener('change', () => {
      const boxes = master.closest('form').querySelectorAll(`input[type="checkbox"][name="${master.dataset.selectAll}"]`);
      boxes.forEach((box) => {
        box.checked = master.checked;
      });
    });
  });

  // Contract form: only show the "client" / "staff member" / "other" box that applies.
  const partySelect = document.querySelector('[data-party-select]');
  if (partySelect) {
    const showParty = () => {
      document.querySelectorAll('[data-party]').forEach((field) => {
        field.hidden = field.dataset.party !== partySelect.value;
      });
    };
    partySelect.addEventListener('change', showParty);
    showParty();
  }

  // Training forms: only show "name of the new training" when "+ New training…" is picked.
  document.querySelectorAll('[data-course-select]').forEach((select) => {
    const newFields = select.closest('fieldset').querySelector('[data-new-course]');
    const showNew = () => {
      newFields.hidden = select.value !== 'new';
    };
    select.addEventListener('change', () => {
      showNew();
      if (select.value === 'new') newFields.querySelector('input').focus();
    });
    showNew();
  });

  // Parts of a form that only apply to one choice: data-shown-for="repeat=weekly"
  // shows it when that radio button is picked; data-hidden-when-checked="all_day"
  // hides it while that box is ticked.
  document.querySelectorAll('[data-shown-for], [data-hidden-when-checked]').forEach((part) => {
    const form = part.closest('form');
    const update = () => {
      if (part.dataset.shownFor) {
        const [name, value] = part.dataset.shownFor.split('=');
        part.hidden = form.querySelector(`[name="${name}"]:checked`)?.value !== value;
      } else {
        part.hidden = Boolean(form.querySelector(`[name="${part.dataset.hiddenWhenChecked}"]`)?.checked);
      }
    };
    form.addEventListener('change', update);
    update();
  });

  // App notifications: the "Turn on notifications" box (views/partials/notifications.ejs).
  const pushBox = document.querySelector('[data-push]');
  if (pushBox) setUpNotifications(pushBox);

  // Passkeys: the "Sign in with a passkey" and "Add a passkey" buttons.
  document.querySelectorAll('[data-passkey]').forEach(setUpPasskey);

  // Phone-sized screens: open and close the side menu.
  const toggle = document.querySelector('[data-nav-toggle]');
  if (toggle) {
    const setOpen = (open) => {
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setOpen(!document.body.classList.contains('nav-open'));
    });
    document.addEventListener('click', (event) => {
      if (document.body.classList.contains('nav-open') && !event.target.closest('#sidebar')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
  }
});

// Free "push" notifications on this device. The browser asks the person's
// permission, then gives us an address for this device, which we save with
// their account. public/sw.js shows the notifications when they arrive.
function setUpNotifications(box) {
  const $ = (selector) => box.querySelector(selector);
  const status = $('[data-push-status]');
  const show = (selector, visible) => {
    $(selector).hidden = !visible;
  };
  const send = async (url, fields) => {
    const body = new URLSearchParams({ _csrf: $('input[name="_csrf"]').value, ...fields });
    const reply = await fetch(url, { method: 'POST', body, credentials: 'same-origin' });
    if (!reply.ok) throw new Error(`the site answered ${reply.status}`);
    return reply.json();
  };
  const ua = navigator.userAgent;
  const isApple = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const onHomeScreen = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const deviceName = isApple ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android phone' : 'Computer';
  // The site's public key, as the bytes the browser wants.
  const siteKey = () => {
    const text = box.dataset.pushKey.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(text + '='.repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };

  async function refresh() {
    ['[data-push-on]', '[data-push-off]', '[data-push-test]', '[data-push-apple]'].forEach((s) => show(s, false));
    if (!supported) {
      if (isApple && !onHomeScreen) {
        status.textContent = 'Off. On an iPhone or iPad, add DMI to your Home Screen first:';
        show('[data-push-apple]', true);
      } else {
        status.textContent = "This browser can't show notifications. Try Chrome, Edge, Firefox or Safari.";
      }
      return;
    }
    if (Notification.permission === 'denied') {
      status.textContent = 'Blocked. Allow notifications for this site in your browser or phone settings, then reload this page.';
      return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js');
    const subscription = await registration.pushManager.getSubscription();
    status.textContent = subscription ? 'On for this device.' : 'Off on this device.';
    show('[data-push-on]', !subscription);
    show('[data-push-test]', Boolean(subscription));
    show('[data-push-off]', Boolean(subscription));
  }

  $('[data-push-on]').addEventListener('click', async () => {
    try {
      status.textContent = 'Turning on…';
      if ((await Notification.requestPermission()) !== 'granted') return refresh();
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: siteKey() });
      const { keys } = subscription.toJSON();
      await send('/account/push', { endpoint: subscription.endpoint, p256dh: keys.p256dh, auth: keys.auth, device: deviceName });
      await refresh();
    } catch (err) {
      status.textContent = `Couldn't turn notifications on (${err.message}). Please try again.`;
    }
  });

  $('[data-push-off]').addEventListener('click', async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await send('/account/push/remove', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      await refresh();
    } catch (err) {
      status.textContent = `Couldn't turn notifications off (${err.message}).`;
    }
  });

  $('[data-push-test]').addEventListener('click', async () => {
    try {
      const { sent } = await send('/account/push/test', {});
      status.textContent = sent ? 'Test sent. It should pop up in a few seconds.' : "Couldn't reach this device. Turn notifications off, then on again.";
    } catch (err) {
      status.textContent = `Couldn't send a test (${err.message}).`;
    }
  });

  refresh().catch((err) => {
    status.textContent = `Couldn't check notifications on this device (${err.message}).`;
  });
}

// Passkeys: signing in with Face ID, Touch ID or the device's screen lock
// (src/services/passkeys.js checks the answers). The browser does the hard
// part. We get a one-time "challenge" from the site, the browser asks for
// Face ID (or similar) and signs it, and we send the signed answer back.
//
// The challenge is fetched as soon as the page opens, not when the button is
// tapped: iPhones only allow the Face ID prompt straight after a tap.
const PASSKEY_URLS = {
  login: ['/login/passkey/options', '/login/passkey'], // sign in, or the second step after a password
  confirm: ['/account/confirm/passkey-options', '/account/confirm/passkey'], // "Confirm it's you"
  register: ['/account/passkeys/options', '/account/passkeys'], // add a passkey
};
const REFRESH_MS = 4 * 60 * 1000; // challenges last 5 minutes on the site

// Bytes <-> the URL-safe text ("base64url") the site sends and expects.
const toText = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const toBytes = (text) => {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(plain + '='.repeat((4 - (plain.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

function setUpPasskey(box) {
  const kind = box.dataset.passkey;
  const [optionsUrl, sendUrl] = PASSKEY_URLS[kind];
  const button = box.querySelector('[data-passkey-start]');
  const errorBox = document.querySelector('[data-passkey-error]');
  const csrf = document.querySelector('input[name="_csrf"]').value;
  const canCreate = window.AuthenticatorAttestationResponse && 'getPublicKey' in AuthenticatorAttestationResponse.prototype;
  if (!window.PublicKeyCredential || !navigator.credentials || (kind === 'register' && !canCreate)) {
    // Boxes that start hidden stay hidden; others say why the button is missing.
    button.hidden = true;
    box.querySelector('[data-passkey-unsupported]')?.removeAttribute('hidden');
    return;
  }
  box.hidden = false;
  document.querySelectorAll('[data-passkey-alt]').forEach((part) => {
    part.hidden = false;
  });

  let options = null; // the latest challenge and settings from the site
  let autofill = null; // lets us cancel the passkey offer in the email box
  let busy = false;
  let tapped = false; // after the button's been used, the email box stops offering passkeys
  const showError = (message) => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = !message;
  };

  // The site's options, turned into what the browser wants (bytes, not text).
  const forBrowser = () => {
    const publicKey = { ...options, challenge: toBytes(options.challenge) };
    if (options.user) publicKey.user = { ...options.user, id: toBytes(options.user.id) };
    for (const list of ['allowCredentials', 'excludeCredentials']) {
      if (options[list]) publicKey[list] = options[list].map((c) => ({ ...c, id: toBytes(c.id) }));
    }
    return publicKey;
  };

  async function load() {
    autofill?.abort();
    autofill = null;
    button.disabled = true; // until the new challenge is here
    try {
      const reply = await fetch(optionsUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      options = await reply.json(); // or { error, redirect }, e.g. "confirm it's you first"
    } catch {
      options = { error: 'Could not reach the site. Check your connection, then reload this page.' };
    }
    button.disabled = false;
    if (box.hasAttribute('data-passkey-autofill') && options.challenge && !tapped) offerInEmailBox();
  }

  // On the sign-in page, phones and browsers can offer saved passkeys right
  // in the email box ("conditional mediation"), so there's nothing to tap first.
  async function offerInEmailBox() {
    if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
    const controller = new AbortController();
    autofill = controller;
    try {
      const credential = await navigator.credentials.get({ publicKey: forBrowser(), mediation: 'conditional', signal: controller.signal });
      busy = true;
      await send(credential);
    } catch (err) {
      // Cancelled by us (the button was tapped, or the page refreshed its challenge) or by the browser: nothing to say.
      if (err.fromSite) failed(err);
    } finally {
      busy = false;
    }
  }

  // Sends the signed answer. The site replies with the page to go to next.
  async function send(credential) {
    const answer = credential.response;
    const fields = { _csrf: csrf, id: toText(credential.rawId), clientDataJSON: toText(answer.clientDataJSON) };
    if (kind === 'register') {
      Object.assign(fields, {
        authenticatorData: toText(answer.getAuthenticatorData()),
        publicKey: toText(answer.getPublicKey()),
        publicKeyAlgorithm: String(answer.getPublicKeyAlgorithm()),
      });
    } else {
      Object.assign(fields, {
        authenticatorData: toText(answer.authenticatorData),
        signature: toText(answer.signature),
        userHandle: answer.userHandle ? toText(answer.userHandle) : '',
        next: box.dataset.next || document.querySelector('input[name="next"]')?.value || '',
      });
    }
    const reply = await fetch(sendUrl, { method: 'POST', body: new URLSearchParams(fields), credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const result = await reply.json().catch(() => ({}));
    if (result.redirect) {
      window.location.href = result.redirect;
      return;
    }
    throw Object.assign(new Error(result.error || 'Something went wrong. Please reload this page and try again.'), { fromSite: true });
  }

  function failed(err) {
    if (err.fromSite) showError(err.message);
    else if (err.name === 'InvalidStateError') showError('This device already has a passkey for your account. You can use it to sign in.');
    else if (err.name === 'NotAllowedError') {
      showError(kind === 'register'
        ? 'No passkey was added (it was cancelled or took too long). Tap the button to try again.'
        : "No passkey was used (it was cancelled, took too long, or this device doesn't have one for this site). Tap the button to try again.");
    } else showError(`Passkeys didn't work here (${err.message}). Please try again.`);
    load(); // a fresh challenge for the next try
  }

  button.addEventListener('click', async () => {
    showError('');
    if (options.redirect) {
      window.location.href = options.redirect;
      return;
    }
    if (!options.challenge) return showError(options.error || 'Please reload this page and try again.');
    autofill?.abort(); // the button takes over from the email box
    autofill = null;
    tapped = true;
    busy = true;
    button.disabled = true;
    try {
      // Called straight away (no waiting first), so iPhones allow the prompt.
      const publicKey = forBrowser();
      const credential = kind === 'register' ? await navigator.credentials.create({ publicKey }) : await navigator.credentials.get({ publicKey });
      await send(credential);
    } catch (err) {
      failed(err);
    } finally {
      busy = false;
    }
  });

  load();
  setInterval(() => {
    if (!busy) load();
  }, REFRESH_MS);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !busy) load(); // back to this page from the next one
  });
}
