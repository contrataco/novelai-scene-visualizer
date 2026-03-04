// utils.js — Shared utilities

import { toastEl } from './dom-refs.js';

export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOAST_ICONS = {
  success: '\u2713',
  error: '\u2717',
  warn: '\u26A0',
  info: '\u2139',
};

let toastTimer = null;

export function showToast(msg, duration = 2500, variant = '') {
  const icon = TOAST_ICONS[variant] || '';
  toastEl.innerHTML = (icon ? `<span class="toast-icon">${icon}</span> ` : '') + escapeHtml(msg);
  toastEl.className = 'toast show' + (variant ? ' ' + variant : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, duration);
}

// Structured error banner for inline error display
export function showError(container, message, detail = '') {
  container.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:8px;background:var(--error-bg-subtle);border:1px solid var(--error-border);border-radius:6px;padding:8px 12px;font-size:11px;color:var(--error-light);">
      <span style="font-size:14px;flex-shrink:0;">\u26A0</span>
      <div style="flex:1;">
        <div>${escapeHtml(message)}</div>
        ${detail ? `<div style="color:var(--error-soft);font-size:10px;margin-top:2px;">${escapeHtml(detail)}</div>` : ''}
      </div>
      <button onclick="this.parentElement.parentElement.style.display='none'" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:0;">\u00D7</button>
    </div>
  `;
  container.style.display = '';
}
