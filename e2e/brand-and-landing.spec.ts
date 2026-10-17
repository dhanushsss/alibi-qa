/**
 * F. Zerqis brand, marketing landing page, documentation, full-width app shell,
 * motion, and accessibility (real server, seeded data, no provider calls).
 *
 * Technical identifiers that intentionally keep the old name are excluded from the
 * brand check: ALIBI_* environment variable names, the alibi-demo/* sample
 * repository names, and this suite's own alibi-qa/* scenario repositories and their
 * "(alibi-qa … scenario|fixture)" description tags, which are fixture data.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, horizontalOverflow, test } from './support/fixtures.ts';

const TITLE = 'Zerqis — Evidence-driven CI investigation';
const visibleBrandLeaks = (page: Page) =>
  page.evaluate(() => {
    const text = document.body.innerText.replace(/alibi-(demo|qa)\//gi, '').replace(/\(alibi-qa [a-z ]+\)/gi, '').replace(/\bALIBI_[A-Z0-9_]+/g, '');
    const attrs = [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')]
      .map((el) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => el.getAttribute(a) ?? '').join(' '))
      .join(' ')
      .replace(/alibi-(demo|qa)\//gi, '');
    return [...`${text} ${attrs} ${document.title}`.matchAll(/.{0,40}alibi.{0,40}/gi)].map((m) => m[0]);
  });

async function audit(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test('[F1] title, description, application name, and favicon carry the Zerqis brand', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(TITLE);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /^Zerqis investigates failed CI builds/);
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', 'Zerqis');
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href).toBe('/favicon.svg');
  const svg = await (await request.get(href!)).text();
  expect(svg).toContain('<svg');
  expect(svg).toContain('#10b981');
});

test('[F2] no visible or accessible-name "Alibi" branding on any route', async ({ page, seeded }) => {
  const routes = ['/', '/docs', '/overview', '/investigations', '/integrations', '/settings', `/investigations/${seeded.replayId}`, `/investigations/${seeded.replayId}/ledger`, '/no-such-page'];
  for (const r of routes) {
    await page.goto(r);
    await page.waitForLoadState('networkidle');
    expect(await visibleBrandLeaks(page), `old brand visible on ${r}`).toEqual([]);
  }
  await page.goto('/overview');
  await expect(page.getByRole('link', { name: 'Zerqis home' }).first()).toBeAttached();
});

test('[F3] landing navigation and CTAs reach real destinations', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: "Don't just explain the failure. Prove it." })).toBeVisible();
  await expect(page.getByRole('link', { name: /sign in/i })).toHaveCount(0);

  const site = page.getByRole('navigation', { name: 'Site' });
  for (const [name, id] of [['How it works', 'how'], ['Use cases', 'use-cases'], ['Product', 'product']] as const) {
    await site.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`/#${id}$`));
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }

  await page.getByRole('button', { name: 'Watch a sample investigation' }).first().click();
  const sample = page.locator('#sample');
  await expect(sample).toBeInViewport();
  await expect(sample.getByRole('button', { name: 'Pause sample' })).toBeVisible();
  await expect(sample.getByText('Sample investigation')).toBeVisible();

  await site.getByRole('link', { name: 'Documentation' }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Zerqis product guide' })).toBeVisible();
  await expect(page).toHaveTitle('Documentation · Zerqis');

  await page.goto('/');
  await page.getByRole('link', { name: /Explore the product/ }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
});

test('[F4] the sample walkthrough is labelled, pausable, and stops at the end', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const sample = page.locator('#sample');
  await expect(sample.getByRole('button', { name: 'Pause sample' })).toBeVisible();
  await expect(sample.getByText(/Recorded run/)).toBeVisible();
  await expect(sample.getByText(/Nothing runs and no model is called/)).toBeVisible();
  const current = sample.locator('[aria-current="step"]');
  await expect(current).toHaveText('Failure');
  await sample.getByRole('button', { name: 'Pause sample' }).click();
  await page.clock.runFor(15_000);
  await expect(current).toHaveText('Failure');
  await sample.getByRole('button', { name: 'Play sample' }).click();
  for (let i = 0; i < 6; i++) await page.clock.runFor(2_700);
  await expect(current).toHaveText('Fix validation');
  await expect(sample.getByRole('button', { name: 'Replay sample' })).toBeVisible();
});

test('[F5] reduced motion: no autoplay, no hidden scroll-reveal content', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const sample = page.locator('#sample');
  await expect(sample.locator('[aria-current="step"]')).toHaveText('Fix validation');
  await expect(sample.getByRole('button', { name: 'Replay sample' })).toBeVisible();
  await expect(page.locator('.reveal-on')).toHaveCount(0);
  const hidden = await page.locator('[data-reveal]').evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity !== '1').length);
  expect(hidden).toBe(0);
});

for (const width of [1440, 1280, 1024, 768, 390]) {
  test(`[F6] ${width}px: landing, docs, and app pages have no horizontal page overflow`, async ({ page, seeded }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const r of ['/', '/docs', '/overview', '/investigations', '/integrations', '/settings', `/investigations/${seeded.replayId}`]) {
      await page.goto(r);
      await page.waitForLoadState('networkidle');
      expect(await horizontalOverflow(page), `${r} overflows at ${width}px`).toBeLessThanOrEqual(1);
    }
  });
}

for (const width of [1920, 1440, 1280, 1024]) {
  test(`[F7] ${width}px: the app content area uses the width beside the sidebar`, async ({ page, seeded }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const r of ['/overview', `/investigations/${seeded.replayId}`, '/integrations']) {
      await page.goto(r);
      await page.waitForLoadState('networkidle');
      const m = await page.evaluate(() => {
        const main = document.querySelector('.main')!.getBoundingClientRect();
        const content = document.querySelector('.content')!.getBoundingClientRect();
        return { mainLeft: main.left, mainRight: main.right, left: content.left, right: content.right, vw: document.documentElement.clientWidth };
      });
      expect(m.mainRight, `${r}: main column reaches the viewport edge`).toBeGreaterThanOrEqual(m.vw - 1);
      // Content spans the main column (its own padding is the only gutter).
      expect(m.right - m.left, `${r}: content width at ${width}px`).toBeGreaterThanOrEqual(m.mainRight - m.mainLeft - 1);
    }
  });
}

test('[F8] keyboard: skip link first, then site navigation with a visible focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  const target = page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Documentation' });
  for (let i = 0; i < 10 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  const outline = await target.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThan(0);
});

test('[F9] mobile: the site menu opens, navigates, and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const btn = page.getByRole('button', { name: 'Open site menu' });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Site menu' }).getByRole('link', { name: 'Use cases' }).click();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#use-cases')).toBeInViewport();
});

for (const [path, heading] of [['/', "Don't just explain the failure. Prove it."], ['/docs', 'Zerqis product guide']] as const) {
  test(`[F10] ${path} has no serious or critical WCAG A/AA violations`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // audit final, fully revealed content
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await audit(page)).toEqual([]);
  });
}

test('[F11] the landing page makes no API calls', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url());
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('#product').scrollIntoViewIfNeeded();
  await page.waitForLoadState('networkidle');
  expect(api).toEqual([]);
});
