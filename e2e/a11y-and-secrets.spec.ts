/** E. Keyboard access, visible focus, reduced motion, and secret leakage on settings pages. */
import { MOCK_SECRETS } from '../scripts/lib/alibi-server.ts';
import { expect, test } from './support/fixtures.ts';

test('[E5] the skip link is the first focusable element and moves focus to the main content', async ({ page }) => {
  await page.goto('/overview');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box && box.y >= 0 && box.height > 0, 'skip link is visible when focused').toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test('[E5] navigation links are reachable by keyboard and show a visible focus indicator', async ({ page }) => {
  await page.goto('/overview');
  const target = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Integrations' });
  for (let i = 0; i < 15 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  const outline = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
});

test('[E5] Escape closes the mobile navigation drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/overview');
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('[E5] reduced motion disables animations and transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/overview');
  const styles = await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'spin';
    document.body.appendChild(el);
    const nav = document.querySelector('.nav a') as HTMLElement;
    return { spin: getComputedStyle(el).animationName, navTransition: parseFloat(getComputedStyle(nav).transitionDuration) };
  });
  expect(styles.spin).toBe('none');
  expect(styles.navTransition).toBeLessThan(0.01);
});

test('[E7] integrations and settings never expose configured credentials', async ({ page }) => {
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/')) bodies.push(await r.text().catch(() => ''));
  });
  for (const [path, heading] of [['/integrations', 'Integrations'], ['/settings', 'Settings']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    const html = await page.content();
    for (const [name, v] of Object.entries(MOCK_SECRETS)) {
      expect(text.includes(v), `${name} visible on ${path}`).toBe(false);
      expect(html.includes(v), `${name} in the DOM of ${path}`).toBe(false);
    }
  }
  for (const v of Object.values(MOCK_SECRETS)) expect(bodies.some((b) => b.includes(v)), 'credential in an API response').toBe(false);
});
