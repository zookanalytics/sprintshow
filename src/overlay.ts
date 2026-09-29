// On-screen chrome rendered inside the page: the step caption bar and the cover /
// scrutiny cards. Rendering in the DOM (not with ffmpeg `drawtext`) keeps text crisp in
// the app's own font and lets the walkthrough path show live, animated captions.
//
// The still-frame path injects a caption, screenshots, and removes it; the walkthrough
// path leaves the caption up and updates it in place, and shows the cards as full-screen
// overlays for a few seconds while recording continues.

import type { Page } from 'playwright';

const ACCENT = '#6ad08a';
const ACCENT_FAIL = '#e0554e';
const BG = '#0f1115';
const FG = '#e7e9ee';
const MUTED = '#9aa3b2';
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** HTML-escape text bound for `innerHTML` / `setContent`. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Show (or update, if already present) the step caption bar at the bottom of the page.
 * Idempotent, so the walkthrough path can call it every step to retitle the same bar.
 */
export async function showCaption(page: Page, idx: number, total: number, text: string, failed: boolean): Promise<void> {
  await page.evaluate(
    ({ idx, total, text, failed, ACCENT, ACCENT_FAIL, FONT }) => {
      const ID = '__ss_caption__';
      const accent = failed ? ACCENT_FAIL : ACCENT;
      let bar = document.getElementById(ID);
      if (!bar) {
        bar = document.createElement('div');
        bar.id = ID;
        Object.assign(bar.style, {
          position: 'fixed',
          left: '0',
          right: '0',
          bottom: '0',
          zIndex: '2147483647',
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          padding: '16px 22px',
          background: 'rgba(9, 11, 15, 0.86)',
          color: '#e7e9ee',
          font: `18px/1.4 ${FONT}`,
          boxShadow: '0 -10px 30px rgba(0,0,0,0.35)',
          transition: 'border-color .2s ease',
        });
        const counter = document.createElement('span');
        counter.dataset.role = 'counter';
        Object.assign(counter.style, {
          flex: '0 0 auto',
          fontWeight: '700',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '15px',
          borderRadius: '6px',
          padding: '2px 8px',
        });
        const label = document.createElement('span');
        label.dataset.role = 'label';
        const badge = document.createElement('span');
        badge.dataset.role = 'badge';
        Object.assign(badge.style, {
          marginLeft: 'auto',
          flex: '0 0 auto',
          color: '#0b0e12',
          fontWeight: '700',
          fontSize: '12px',
          letterSpacing: '0.06em',
          borderRadius: '6px',
          padding: '3px 8px',
          display: 'none',
        });
        badge.textContent = 'PROOF FAILED';
        bar.append(counter, label, badge);
        document.body.appendChild(bar);
      }
      bar.style.borderTop = `3px solid ${accent}`;
      const counter = bar.querySelector('[data-role=counter]') as HTMLElement;
      counter.textContent = `${idx} / ${total}`;
      counter.style.color = accent;
      counter.style.border = `1px solid ${accent}`;
      (bar.querySelector('[data-role=label]') as HTMLElement).textContent = text;
      const badge = bar.querySelector('[data-role=badge]') as HTMLElement;
      badge.style.display = failed ? 'inline-block' : 'none';
      badge.style.background = accent;
    },
    { idx, total, text, failed, ACCENT, ACCENT_FAIL, FONT },
  );
}

export async function removeCaption(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('__ss_caption__')?.remove());
}

/** Inner HTML of the cover card — the title, subtitle and a one-line meta footer. */
export function coverInnerHtml(brand: string, title: string, description: string, meta: string): string {
  return (
    `<div style="color:${ACCENT};font-size:14px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;">${esc(brand)}</div>` +
    `<div style="font-size:44px;font-weight:700;line-height:1.15;">${esc(title)}</div>` +
    (description ? `<div style="font-size:20px;color:${MUTED};max-width:60ch;line-height:1.5;">${esc(description)}</div>` : '') +
    `<div style="font-size:15px;color:${MUTED};">${esc(meta)}</div>`
  );
}

/** Inner HTML of the scrutiny card — the "look here critically" list. */
export function scrutinyInnerHtml(items: string[]): string {
  return (
    `<div style="color:${ACCENT};font-size:14px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;">scrutiny — look here critically</div>` +
    `<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:16px;font-size:24px;line-height:1.4;max-width:70ch;">` +
    items.map((s) => `<li style="display:flex;gap:14px;"><span style="color:${ACCENT};">·</span><span>${esc(s)}</span></li>`).join('') +
    `</ul>`
  );
}

/** Wrap card inner-HTML into a full document for `page.setContent` (the still-frame path). */
export function cardDocument(inner: string): string {
  return (
    `<!doctype html><html><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;gap:20px;padding:0 8vw;` +
    `background:${BG};color:${FG};font-family:${FONT};">${inner}</body></html>`
  );
}

/**
 * Show a full-screen card over the live page for `ms`, then remove it (the walkthrough
 * path, where the recording keeps rolling and the page must not be navigated away).
 */
export async function showCardOverlay(page: Page, inner: string, ms: number): Promise<void> {
  await page.evaluate(
    ({ inner, BG, FG, FONT }) => {
      const el = document.createElement('div');
      el.id = '__ss_card__';
      Object.assign(el.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: '20px',
        padding: '0 8vw',
        background: BG,
        color: FG,
        fontFamily: FONT,
        opacity: '0',
        transition: 'opacity .35s ease',
      });
      el.innerHTML = inner;
      document.body.appendChild(el);
      requestAnimationFrame(() => (el.style.opacity = '1'));
    },
    { inner, BG, FG, FONT },
  );
  await page.waitForTimeout(ms);
  await page.evaluate(() => {
    const el = document.getElementById('__ss_card__');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 360);
  });
  await page.waitForTimeout(380);
}
