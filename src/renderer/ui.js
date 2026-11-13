/* Shared UI pieces used by every renderer page: themed tooltips and dialogs that
   replace the browser's native title bubbles and confirm()/alert() boxes. */
(() => {
  'use strict';
  const escT = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- tooltip ----------------
     Any element with a title gets the themed bubble instead: on hover the title moves to
     data-tip (so the native one never shows) and the bubble appears after a short delay. */
  const tip = document.createElement('div');
  tip.className = 'ui-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  let tipFor = null, tipTimer = 0, tipWarm = 0;
  function adopt(el) {
    const t = el.getAttribute('title');
    if (t == null) return;
    el.removeAttribute('title');
    if (t) {
      el.dataset.tip = t;
      // keep an accessible name for icon-only buttons that relied on the title
      if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t.split('\n')[0]);
    } else delete el.dataset.tip;
  }
  function place() {
    if (!tipFor || !tipFor.isConnected) return hideTip();
    const r = tipFor.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = innerWidth, vh = innerHeight;
    let top = r.bottom + 7, below = true;
    if (top + h > vh - 6) { top = r.top - h - 7; below = false; }
    if (top < 6) { top = Math.min(vh - h - 6, r.bottom + 7); below = true; }
    const left = Math.max(6, Math.min(vw - w - 6, r.left + r.width / 2 - w / 2));
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    tip.classList.toggle('above', !below);
  }
  function showTip(el) {
    const text = el.dataset.tip;
    if (!text) return;
    if (!tip.isConnected) document.body.appendChild(tip);
    tipFor = el;
    const [head, ...rest] = text.split('\n');
    tip.innerHTML = rest.length ? `<b>${escT(head)}</b>${rest.map(l => `<span>${escT(l)}</span>`).join('')}` : escT(head);
    tip.hidden = false; tip.classList.remove('in');
    place();
    requestAnimationFrame(() => tip.classList.add('in'));
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (!tip.hidden) tipWarm = Date.now();
    tipFor = null; tip.hidden = true; tip.classList.remove('in');
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[title],[data-tip]');
    if (el && el.hasAttribute('title')) adopt(el);
    if (el === tipFor) return;
    hideTip();
    if (!el || !el.dataset.tip) return;
    // moving from one tip to the next shows the next one at once
    tipTimer = setTimeout(() => showTip(el), Date.now() - tipWarm < 400 ? 40 : 450);
  }, true);
  document.addEventListener('mouseout', e => { if (tipFor && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) hideTip(); }, true);
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, hideTip, true);
  window.addEventListener('scroll', hideTip, true);
  // a title written while the bubble is showing (e.g. a toggled button) updates it
  new MutationObserver(list => {
    for (const m of list) if (m.target === tipFor && m.target.hasAttribute('title')) { adopt(tipFor); showTip(tipFor); }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['title'] });

  /* ---------------- dialogs ---------------- */
  let open = null;
  function dialog({ title, message = '', detail = '', ok = 'Tamam', cancel = 'Vazgeç', danger = false, icon, alert = false, input = null, placeholder = '', maxLength = 200, choices = null }) {
    if (open) open.finish(false);
    hideTip();
    return new Promise(resolve => {
      const prev = document.activeElement;
      const bg = document.createElement('div');
      bg.className = 'ui-dlg-bg';
      const ic = icon || (danger ? 'fa-triangle-exclamation' : alert ? 'fa-circle-info' : 'fa-circle-question');
      bg.innerHTML = `<div class="ui-dlg${danger ? ' danger' : ''}" role="${alert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="uiDlgT" aria-describedby="uiDlgM">
        <div class="ui-dlg-h"><i class="fa-solid ${ic}"></i><b id="uiDlgT">${escT(title || 'VoxStorm')}</b></div>
        <div class="ui-dlg-m" id="uiDlgM">${escT(message).replace(/\n/g, '<br>')}${detail ? `<p>${escT(detail).replace(/\n/g, '<br>')}</p>` : ''}${input != null ? `<input class="ui-dlg-in" type="text" spellcheck="false" maxlength="${+maxLength || 200}" value="${escT(input)}" placeholder="${escT(placeholder)}" aria-label="${escT(title || message)}">` : ''}${choices ? `<div class="ui-dlg-ch" role="group" aria-label="${escT(title || message)}">${choices.map((c, i) => `<label class="ui-dlg-c"><input type="checkbox" data-ci="${i}"${c.checked ? ' checked' : ''}><span><b>${escT(c.label)}</b>${c.hint ? `<small>${escT(c.hint)}</small>` : ''}</span></label>`).join('')}</div>` : ''}</div>
        <div class="ui-dlg-f">${alert ? '' : `<button class="btn" data-r="0">${escT(cancel)}</button>`}<button class="btn primary${danger ? ' danger' : ''}" data-r="1">${escT(ok)}</button></div>
      </div>`;
      const inp = bg.querySelector('.ui-dlg-in');
      const finish = r => {
        if (open !== state) return;
        open = null;
        window.removeEventListener('keydown', onKey, true);
        bg.classList.remove('in');
        setTimeout(() => bg.remove(), 120);
        if (prev && prev.isConnected && prev.focus) try { prev.focus(); } catch (_) {}
        resolve(choices ? (r ? [...bg.querySelectorAll('[data-ci]')].filter(c => c.checked).map(c => choices[+c.dataset.ci].value) : null)
          : inp ? (r ? inp.value : null) : r);
      };
      const state = { finish };
      const onKey = e => {
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(alert); }
        else if (e.key === 'Tab') {
          const bs = [...bg.querySelectorAll('input,button')], i = bs.indexOf(document.activeElement);
          e.preventDefault(); bs[(i + (e.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
        }
        else if (e.key === 'Enter' && document.activeElement && document.activeElement.dataset.r == null) { e.preventDefault(); finish(true); }
      };
      bg.addEventListener('mousedown', e => { if (e.target === bg) { e.preventDefault(); bg.querySelector('.ui-dlg').classList.add('shake'); setTimeout(() => bg.querySelector('.ui-dlg').classList.remove('shake'), 300); } });
      bg.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (b) { e.stopPropagation(); finish(b.dataset.r === '1'); } });
      window.addEventListener('keydown', onKey, true);
      open = state;
      document.body.appendChild(bg);
      requestAnimationFrame(() => bg.classList.add('in'));
      // a text box starts focused with its text selected; destructive questions start on the safe button
      if (inp) { inp.focus(); inp.select(); }
      else (bg.querySelector(danger && !alert ? '[data-r="0"]' : '[data-r="1"]')).focus();
    });
  }
  window.uiConfirm = opts => dialog(typeof opts === 'string' ? { message: opts } : opts);
  // resolves to the typed text, or null when cancelled
  window.uiPrompt = opts => dialog(Object.assign({ input: '' }, opts));
  // resolves to the values of the ticked choices ([] when none), or null when cancelled
  window.uiChoose = opts => dialog(Object.assign({ choices: [] }, opts));
  window.uiAlert = opts => dialog(Object.assign({ alert: true }, typeof opts === 'string' ? { message: opts } : opts));
})();
