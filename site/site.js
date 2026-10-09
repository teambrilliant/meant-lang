document.querySelectorAll('[data-option]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-option]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    document.querySelectorAll('[data-option-panel]').forEach(panel => { panel.hidden = panel.dataset.optionPanel !== button.dataset.option; });
  });
});

const scenarios = {
  draft: {
    code: 'scenario SendingADraft\n  with Draft, LineItem\n  the owner sends it via SendInvoice -> Sent',
    outcome: 'Lands in Sent',
    explanation: 'The owner sends a draft with a line item. Its status changes to sent.'
  },
  empty: {
    code: 'scenario SendingAnEmptyDraft\n  with Draft, Empty\n  the owner sends it via SendInvoice -> denied EMPTY_INVOICE',
    outcome: 'Denied: EMPTY_INVOICE',
    explanation: 'The invoice has no line items, so SendInvoice is denied.'
  },
  sent: {
    code: 'scenario SendingTwice\n  with Sent, LineItem\n  the owner sends it again via SendInvoice -> denied NOT_DRAFT',
    outcome: 'Denied: NOT_DRAFT',
    explanation: 'The invoice has already been sent. SendInvoice requires a draft, so the second attempt is denied.'
  }
};
document.querySelectorAll('[data-scenario]').forEach(button => {
  button.addEventListener('click', () => {
    const scenario = scenarios[button.dataset.scenario];
    if (!scenario) return;
    document.querySelectorAll('[data-scenario]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    document.getElementById('scenario-code').textContent = scenario.code;
    document.getElementById('scenario-outcome').textContent = scenario.outcome;
    document.getElementById('scenario-explanation').textContent = scenario.explanation;
  });
});
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    const feedback = document.querySelector('.copy-feedback');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      const previous = button.textContent;
      button.textContent = 'Copied';
      if (feedback) feedback.textContent = 'Code copied to clipboard.';
      setTimeout(() => { button.textContent = previous; }, 1800);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'Code selected';
      if (feedback) feedback.textContent = 'Clipboard unavailable. Code selected for manual copying.';
    }
  });
});
