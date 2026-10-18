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
