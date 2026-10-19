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

  // App notifications: the "Turn on notifications" box (views/partials/notifications.ejs).
  const pushBox = document.querySelector('[data-push]');
  if (pushBox) setUpNotifications(pushBox);

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
