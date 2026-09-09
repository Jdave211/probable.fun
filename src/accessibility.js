const returnTargets = new WeakMap();
let mobileTradeDialog = null;
const tradeBackground = new Set();
const focusable = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export function visibleDialogs() {
  return [...document.querySelectorAll('.modal-overlay:not(.hidden)')];
}

function syncBackground() {
  const open = visibleDialogs().length > 0;
  document.body.classList.toggle('dialog-open', open);
  for (const child of document.querySelector('#app').children) {
    if (!child.classList.contains('modal-overlay') && child.id !== 'toast') child.inert = open;
  }
}

export function enhanceForms(root) {
  for (const review of root.querySelectorAll('[data-market-review]')) {
    review.tabIndex = 0;
    review.setAttribute('role', 'region');
    review.setAttribute('aria-label', 'Market setup review');
  }
  for (const label of root.querySelectorAll('.field-label')) {
    const input = label.closest('.field')?.querySelector('input:not([type="hidden"]), textarea, select');
    if (!input) continue;
    input.id ||= `${input.form?.id || 'field'}-${input.name}`;
    label.htmlFor = input.id;
  }
  for (const input of root.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
    if (input.labels?.length || input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby')) continue;
    const names = {question:'Market question', outcomes:'Outcomes', closesAt:'Trading closes', description:'Resolution rules', groupId:'Invite link or group ID', amount:'Trade amount'};
    input.setAttribute('aria-label', names[input.name] || input.placeholder || input.name || 'Value');
  }
  syncTradeSheet(root);
}

function syncTradeSheet(root) {
  const wasOpen = Boolean(mobileTradeDialog);
  for (const element of tradeBackground) element.inert = false;
  tradeBackground.clear();
  mobileTradeDialog?.removeAttribute('aria-modal');
  mobileTradeDialog?.removeAttribute('role');
  mobileTradeDialog = null;
  const sheet = root.querySelector('.mobile-trade-sheet.open');
  if (sheet && getComputedStyle(sheet).position === 'fixed') {
    mobileTradeDialog = sheet.querySelector('.mobile-trade-sheet-panel');
    mobileTradeDialog.setAttribute('role', 'dialog');
    mobileTradeDialog.setAttribute('aria-modal', 'true');
    mobileTradeDialog.setAttribute('aria-label', 'Trade market');
    let branch = sheet;
    while (branch.parentElement && branch !== document.querySelector('#app')) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || sibling.id === 'toast' || sibling.classList.contains('modal-overlay') || sibling.inert) continue;
        sibling.inert = true;
        tradeBackground.add(sibling);
      }
      branch = branch.parentElement;
    }
    mobileTradeDialog.querySelector('input:not(:disabled), button:not(:disabled)')?.focus();
  } else if (wasOpen) {
    root.querySelector('[data-mobile-trade-toggle]')?.focus();
  }
  document.body.classList.toggle('dialog-open', Boolean(mobileTradeDialog) || visibleDialogs().length > 0);
}

export function activateDialog(overlay) {
  returnTargets.set(overlay, document.activeElement);
  const dialog = overlay.querySelector('.modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  const title = dialog.querySelector('.modal-title');
  if (title) {
    title.id ||= `${overlay.id}-title`;
    dialog.setAttribute('aria-labelledby', title.id);
  }
  enhanceForms(dialog);
  syncBackground();
  const candidates = [...dialog.querySelectorAll(focusable)].filter(el => el.getClientRects().length);
  (candidates.find(el => el.matches('input, textarea, select')) || candidates[0] || dialog).focus();
}

export function deactivateDialog(overlay) {
  syncBackground();
  const target = returnTargets.get(overlay);
  if (target?.isConnected && !target.closest('.hidden, [inert]')) target.focus();
  returnTargets.delete(overlay);
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mobileTradeDialog && !visibleDialogs().length) {
    event.preventDefault();
    mobileTradeDialog.querySelector('[data-mobile-trade-close]')?.click();
    return;
  }
  if (event.key !== 'Tab') return;
  const overlay = visibleDialogs().at(-1) || mobileTradeDialog;
  if (!overlay) return;
  const candidates = [...overlay.querySelectorAll(focusable)].filter(el => el.getClientRects().length);
  const first = candidates[0];
  const last = candidates.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
});
