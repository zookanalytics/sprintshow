// The keyboard a `press` directive drives, in a page script and in a terminal script
// alike: each key in turn, a key name pressed through Playwright's keyboard and a
// double-quoted string typed. A key goes wherever the page's focus is, as a user's does.
// In a page script that is the app's own focus, so Tab and Shift+Tab move it and the
// browser draws the page's focus ring where it lands. The terminal focuses its emulator
// before it presses (terminal.ts), so its keys reach the shell.

import type { Page } from 'playwright';

import type { PressKey } from './demo-script.ts';

export interface PressPace {
  /** Milliseconds between typed characters. */
  typeDelay: number;
  /** A pause between keys, so a recording shows each one land. */
  keyPause: number;
  /** A pause after the last key, so its effect reads in a recording. */
  pause: number;
}

/** Press each key in turn, or type a quoted key's text, into whatever has focus. It waits for nothing the keys cause. */
export async function pressKeys(page: Page, keys: PressKey[], pace: PressPace): Promise<void> {
  for (const [i, k] of keys.entries()) {
    if ('text' in k) await page.keyboard.type(k.text, { delay: pace.typeDelay });
    else await page.keyboard.press(k.key);
    const pause = i + 1 < keys.length ? pace.keyPause : pace.pause;
    if (pause > 0) await page.waitForTimeout(pause);
  }
}
