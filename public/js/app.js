// Small bits of interactivity. Every page still works without JavaScript;
// this file just makes things a little smoother.
// Chrome and Edge offer to install the site as an app ("Add to Home Screen").
// Kept for the Install button (setUpInstall below) on pages that have one.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  if (!document.querySelector('[data-install]')) return; // elsewhere, the browser's own offer
  event.preventDefault();
  installPrompt = event;
  document.dispatchEvent(new Event('dmi:installable'));
});

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

  // Messages: send without reloading, and check for new ones every few seconds.
  const chatBox = document.querySelector('[data-chat]');
  if (chatBox) setUpChat(chatBox);
  // Secure PDF: once the download has started, clear the password and close the form.
  document.querySelectorAll('.chat-download-form').forEach((form) => {
    form.addEventListener('submit', () => {
      setTimeout(() => {
        form.reset();
        form.closest('details').open = false;
      }, 800);
    });
  });

  // Staff form: only show the pay fields that go with the employment type
  // (and, for Full Time, hourly or salary). data-show-for lists types with |.
  const payForm = document.querySelector('[data-pay-form]');
  if (payForm) {
    const showPay = () => {
      const type = payForm.querySelector('input[name="employment_type"]:checked');
      const options = type ? type.dataset.payOptions.split(' ') : [];
      const chosen = payForm.querySelector('input[name="pay_basis"]:checked');
      const basis = options.includes(chosen && chosen.value) ? chosen.value : options[0];
      payForm.querySelectorAll('[data-show-for], [data-pay]').forEach((field) => {
        const typeOk = !field.dataset.showFor || (type && field.dataset.showFor.split('|').includes(type.value));
        const payOk = !field.dataset.pay || field.dataset.pay === basis;
        field.hidden = !type || !typeOk || !payOk;
      });
    };
    payForm.addEventListener('change', showPay);
    showPay();
  }

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

  // Parts of a form shown only while one of some boxes is ticked: data-shown-if-any="a,b"
  // (e.g. the firearm questions on an incident report). Hidden answers are still kept.
  document.querySelectorAll('[data-shown-if-any]').forEach((part) => {
    const form = part.closest('form');
    const names = part.dataset.shownIfAny.split(',');
    const update = () => {
      part.hidden = !names.some((name) => form.querySelector(`[name="${name}"]`)?.checked);
    };
    form.addEventListener('change', update);
    update();
  });

  // Long forms (incident reports) keep a copy of what's typed on this phone.
  const backupForm = document.querySelector('form[data-backup]');
  if (backupForm) setUpBackup(backupForm);

  // "Add file" on a draft: save the draft first, so nothing typed is lost when the page reloads.
  document.querySelectorAll('form[data-save-first]').forEach((upload) => {
    upload.addEventListener('submit', async (event) => {
      const draft = document.querySelector(upload.dataset.saveFirst);
      if (!draft || upload.dataset.saved) return;
      event.preventDefault();
      try {
        const body = new URLSearchParams([...new FormData(draft)].filter(([, value]) => typeof value === 'string'));
        body.set('action', 'save');
        await fetch(draft.getAttribute('action'), { method: 'POST', body, credentials: 'same-origin' }); // (draft.action would be its "action" buttons)
      } catch {
        // The phone's backup copy still has it.
      }
      upload.dataset.saved = '1';
      upload.submit();
    });
  });

  // "Add DMI to your Home Screen" (views/partials/install.ejs).
  const installBox = document.querySelector('[data-install]');
  if (installBox) setUpInstall(installBox);

  // A phone that has notifications on gets them for whoever is signed in on it.
  if (document.body.dataset.user && !document.querySelector('[data-push]')) linkThisDevice().catch(() => {});

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
  // Sends this browser's notification address to the site, for whoever is signed in.
  const link = (subscription) => {
    const { keys } = subscription.toJSON();
    return send('/account/push', { endpoint: subscription.endpoint, p256dh: keys.p256dh, auth: keys.auth, device: deviceName() });
  };
  // On the setup page: the page to go to once notifications are on.
  const continueTo = box.dataset.pushContinue;
  let linked = false;
  const ua = navigator.userAgent;
  const isApple = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const onHomeScreen = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // The site's public key, as the bytes the browser wants.
  const siteKey = () => {
    const text = box.dataset.pushKey.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(text + '='.repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };

  async function refresh() {
    ['[data-push-on]', '[data-push-off]', '[data-push-test]', '[data-push-apple]'].forEach((s) => show(s, false));
    if (!supported) {
      if (isApple && !onHomeScreen) {
        status.textContent = 'pushAfterInstall' in box.dataset ? 'Not yet.' : 'Off. On an iPhone or iPad, add DMI to your Home Screen first:';
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
    if (subscription && !linked) {
      // Already on in this browser (perhaps for someone else who signed in here): link it to this account.
      linked = true;
      await link(subscription);
      if (continueTo) return window.location.assign(continueTo);
    }
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
      await link(subscription);
      linked = true;
      if (continueTo) {
        status.textContent = 'On. Opening your schedule…';
        return window.location.assign(continueTo);
      }
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

// What to call this device in the list of devices with notifications on.
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPhone or iPad';
  return /Android/.test(ua) ? 'Android phone' : 'Computer';
}

// If this browser already has notifications on (perhaps turned on by someone
// else who signed in here before), they now go to whoever is signed in. Once
// per person per visit. (The notifications box does the same on its pages.)
async function linkThisDevice() {
  const who = document.body.dataset.user;
  const token = document.querySelector('input[name="_csrf"]');
  if (!token || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    if (sessionStorage.getItem('dmi-push-linked') === who) return;
  } catch {
    return; // storage turned off: don't send it on every page
  }
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = registration && (await registration.pushManager.getSubscription());
  if (!subscription) return;
  const { keys } = subscription.toJSON();
  const body = new URLSearchParams({ _csrf: token.value, endpoint: subscription.endpoint, p256dh: keys.p256dh, auth: keys.auth, device: deviceName() });
  const reply = await fetch('/account/push', { method: 'POST', body, credentials: 'same-origin' });
  if (reply.ok) sessionStorage.setItem('dmi-push-linked', who);
}

// "Add DMI to your Home Screen". Phones only let the person do it: Chrome and
// Edge (Android, computers) can show their install box when a button is
// pressed; on an iPhone or iPad it's Safari's Share button, so we show the steps.
function setUpInstall(box) {
  const $ = (selector) => box.querySelector(selector);
  const status = $('[data-install-status]');
  const button = $('[data-install-button]');
  const ua = navigator.userAgent;
  const isApple = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isPhone = isApple || /Android|Mobi/.test(ua);
  const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function show() {
    ['[data-install-apple]', '[data-install-other]'].forEach((s) => {
      $(s).hidden = true;
    });
    button.hidden = true;
    if (installed()) {
      status.textContent = "Done: you're in the DMI app.";
    } else if (isApple) {
      status.textContent = 'Not yet. On an iPhone or iPad, notifications only work in DMI from the Home Screen:';
      $('[data-install-apple]').hidden = false;
    } else if (installPrompt) {
      status.textContent = isPhone ? 'Not yet. Tap the button, then Install:' : 'Optional on a computer:';
      button.hidden = false;
    } else {
      status.textContent = isPhone ? 'Not yet:' : 'Optional on a computer. If your browser offers it:';
      $('[data-install-other]').hidden = false;
    }
  }

  button.addEventListener('click', async () => {
    if (!installPrompt) return show();
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome !== 'accepted') return show();
    button.hidden = true;
    status.textContent = 'Added. You can open DMI from your Home Screen now.';
  });
  document.addEventListener('dmi:installable', show);
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    button.hidden = true;
    status.textContent = 'Added. You can open DMI from your Home Screen now.';
  });
  show();
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

// A copy of a long form's answers, kept on this phone as they're typed, so
// nothing is lost if the connection drops or the sign-in runs out before
// it's saved. If the copy is newer than the last save (data-saved-ms), the
// page offers to put it back.
function setUpBackup(form) {
  const key = `dmi-backup-${form.dataset.backup}`;
  const savedMs = Number(form.dataset.savedMs) || 0;
  const banner = document.querySelector('[data-backup-banner]');
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  };
  const write = (value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or turned off: nothing more we can do.
    }
  };
  const remove = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage turned off.
    }
  };
  const values = () => [...new FormData(form)].filter(([name, value]) => name !== '_csrf' && name !== 'action' && typeof value === 'string');
  const apply = (list) => {
    form.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.checked = false;
    });
    for (const [name, value] of list) {
      const field = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = true;
      else field.value = value;
    }
    form.dispatchEvent(new Event('change'));
  };

  const backup = read();
  if (backup && backup.ms > savedMs && JSON.stringify(backup.values) !== JSON.stringify(values()) && banner) {
    banner.querySelector('[data-backup-time]').textContent = new Date(backup.ms).toLocaleString();
    banner.hidden = false;
    banner.querySelector('[data-backup-restore]').addEventListener('click', () => {
      apply(backup.values);
      banner.hidden = true;
    });
    banner.querySelector('[data-backup-discard]').addEventListener('click', () => {
      remove();
      banner.hidden = true;
    });
  } else if (backup) {
    remove(); // saved since
  }

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => write({ ms: Date.now(), values: values() }), 800);
  };
  form.addEventListener('input', save);
  form.addEventListener('change', save);
}

// Messages (views/chat/thread.ejs). The page works without this: the form
// sends normally and the page reloads. With it, new messages appear by
// themselves while the page is open (asked for every 8 seconds).
function setUpChat(box) {
  const log = box.querySelector('[data-chat-log]');
  const form = box.querySelector('[data-chat-form]');
  const latest = log.querySelector('#latest');
  const problem = box.querySelector('[data-chat-error]');
  let lastId = Number(box.dataset.lastId) || 0;
  const days = log.querySelectorAll('[data-day]');
  let lastDay = days.length ? days[days.length - 1].dataset.day : '';
  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  const add = (m) => {
    if (m.id <= lastId) return;
    lastId = m.id;
    const empty = log.querySelector('[data-chat-empty]');
    if (empty) empty.remove();
    if (m.day !== lastDay) {
      const day = document.createElement('p');
      day.className = 'chat-day';
      day.dataset.day = m.day;
      day.textContent = m.day;
      log.insertBefore(day, latest);
      lastDay = m.day;
    }
    const item = document.createElement('div');
    item.className = `chat-msg${m.right ? ' right' : ''}`;
    item.dataset.id = m.id;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = m.body;
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = `${m.label} · ${m.time}`;
    item.append(bubble, meta);
    log.insertBefore(item, latest);
  };

  let busy = false;
  const check = async (force) => {
    if (busy || (!force && document.visibilityState !== 'visible')) return;
    busy = true;
    try {
      const res = await fetch(`${box.dataset.poll}?after=${lastId}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (res.ok) {
        const { messages } = await res.json();
        if (messages.length) {
          messages.forEach(add);
          scrollDown();
        }
      }
    } catch {
      // Offline for a moment: the next check tries again.
    }
    busy = false;
  };
  setInterval(check, 8000);
  document.addEventListener('visibilitychange', () => check());
  scrollDown();

  form.addEventListener('submit', async (event) => {
    const text = form.elements.body.value.trim();
    if (!text) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    problem.hidden = true;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(String(res.status));
      form.elements.body.value = '';
      while (busy) await new Promise((r) => { setTimeout(r, 100); });
      await check(true);
    } catch {
      problem.hidden = false; // what they wrote stays in the box
    }
    button.disabled = false;
    form.elements.body.focus();
  });
  // On a computer, Enter sends and Shift+Enter starts a new line.
  form.elements.body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}
