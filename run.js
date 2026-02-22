/**
 * Скрипт: заход на Supabase, авторизация, открытие страниц, выход.
 * Интервал: раз в 4 дня
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = join(__dirname, 'credentials.json');
const BROWSER_PROFILE_DIR = join(__dirname, 'browser-profile');

// По умолчанию окно открыто (капчу можно решить). HEADLESS=true — скрытый режим.
const HEADLESS = process.env.HEADLESS === 'true';

// Интервал: раз в 4 дня
const INTERVAL_MS = 4 * 24 * 60 * 60 * 1000;

function log(msg, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, ...args);
}

function loadCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Файл с доступами не найден: ${CREDENTIALS_PATH}. Скопируй credentials.example.json в credentials.json и заполни email/password.`);
  }
  const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!data.email || !data.password) {
    throw new Error('В credentials.json должны быть поля email и password.');
  }
  return data;
}

async function runOnce() {
  const { email, password } = loadCredentials();
  log('Запуск браузера (профиль: browser-profile, headless:', HEADLESS, ')...');

  const launchOptions = {
    headless: HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
  };

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    ...launchOptions,
    channel: 'chrome',
  }).catch(() => chromium.launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions));

  try {
    let page = context.pages()[0] || await context.newPage();
    if (!page) page = await context.newPage();

    // Переход на страницу входа
    log('Переход на страницу входа Supabase...');
    await page.goto('https://supabase.com/dashboard/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Даём время на редирект (если уже залогинены) или на появление формы
    await page.waitForTimeout(4000);
    let currentUrl = page.url();
    let alreadyOnDashboard = currentUrl.includes('/dashboard') && !currentUrl.includes('sign-in');

    if (!alreadyOnDashboard) {
      const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
      const formVisible = await passwordInput.waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
      if (!formVisible) {
        currentUrl = page.url();
        alreadyOnDashboard = currentUrl.includes('/dashboard') && !currentUrl.includes('sign-in');
      }
    }

    if (alreadyOnDashboard) {
      log('Уже залогинены (редирект на дашборд), пропуск формы входа.');
    } else {
      const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
      const passwordInput = page.locator('input[type="password"], input[name="password"]').first();

      const emailVisible = await emailInput.isVisible().catch(() => false);
      if (!emailVisible) {
        const continueEmail = page.getByRole('button', { name: /continue with email|sign in with email|email/i });
        if (await continueEmail.isVisible().catch(() => false)) {
          log('Нажимаю "Continue with Email"...');
          await continueEmail.click();
          await page.waitForTimeout(2000);
        }
      }

      await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
      log('Ввод email и пароля (медленно, как человек)...');
      await emailInput.click();
      await page.waitForTimeout(300);
      for (const c of email) {
        await page.keyboard.type(c, { delay: 50 + Math.random() * 80 });
      }
      await page.waitForTimeout(400);
      await passwordInput.click();
      await page.waitForTimeout(300);
      for (const c of password) {
        await page.keyboard.type(c, { delay: 50 + Math.random() * 80 });
      }
      await page.waitForTimeout(500);

      log('Отправка формы входа...');
      await page.getByRole('button', { name: 'Sign in' }).click();

      const signedIn = await page.waitForURL(/supabase\.com\/dashboard(?!\/sign-in)/, { timeout: 15000 }).then(() => true).catch(() => false);

      if (!signedIn) {
        currentUrl = page.url();
        if (currentUrl.includes('sign-in') || currentUrl.includes('captcha') || currentUrl.includes('challenge')) {
          log('Похоже на капчу или проверку. Текущий URL:', currentUrl);
          if (!HEADLESS) {
            log('Решите капчу в открытом окне браузера. Ожидание до 2 минут...');
            const solved = await page.waitForURL(/supabase\.com\/dashboard(?!\/sign-in)/, { timeout: 120000 }).then(() => true).catch(() => false);
            if (solved) log('Вход выполнен после решения капчи.');
            else {
              await page.screenshot({ path: join(__dirname, 'login-debug.png') });
              log('Таймаут. Скриншот: login-debug.png');
            }
          } else {
            await page.waitForTimeout(5000);
            await page.screenshot({ path: join(__dirname, 'login-debug.png') });
            log('Запусти с видимым окном: set HEADLESS=false && node run.js — затем решите капчу вручную.');
            log('Скриншот: login-debug.png');
          }
        }
      }
    }

    currentUrl = page.url();
    const isLoggedIn = currentUrl.includes('/dashboard') && !currentUrl.includes('sign-in');
    if (!isLoggedIn) {
      log('Авторизация не подтверждена. URL:', currentUrl);
      log('Пропуск дашборда и выхода.');
    } else {
      log('Успешная авторизация. URL:', currentUrl);
    }

    if (!isLoggedIn) return;

    // Переход на страницу организации и сбор проектов из плашки .list-none > li
    const orgDashboardUrl = 'https://supabase.com/dashboard/org/gjfssfplfllpsfliohdh';
    log('Открываю страницу организации:', orgDashboardUrl);
    await page.goto(orgDashboardUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    const projectLinks = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('h5.text-sm.truncate').forEach((el) => {
        const name = (el.textContent || '').trim();
        if (!name) return;
        let a = el.closest('a[href*="/project/"]');
        if (!a) {
          const block = el.closest('li, [class*="card"], [class*="project"], [role="listitem"]');
          a = block?.querySelector?.('a[href*="/project/"]') || null;
        }
        if (a?.href) items.push({ name, href: a.href });
      });
      return items;
    }).catch(() => []);

    if (projectLinks.length > 0) {
      log('Проекты на дашборде:', projectLinks.length);
      projectLinks.forEach((p, i) => log(`  ${i + 1}. ${p.name}`));

      for (const project of projectLinks) {
        log('Захожу в проект:', project.name);
        await page.goto(project.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        const scrollAndWait = async () => {
          const scrolls = 2 + Math.floor(Math.random() * 3);
          for (let i = 0; i < scrolls; i++) {
            await page.mouse.wheel(0, 200 + Math.random() * 300);
            await page.waitForTimeout(800 + Math.random() * 1200);
          }
        };
        await scrollAndWait();
        log('Ожидание 10 сек в проекте', project.name);
        await page.waitForTimeout(10000);
        await scrollAndWait();

        log('Выхожу из проекта', project.name);
        await page.goto(orgDashboardUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
      }
      log('Обработаны все проекты.');
    } else {
      log('Проекты не найдены (h5.text-sm.truncate внутри a[href*="/project/"]).');
    }

    // Открываем ещё страницу Account
    log('Открываю страницу: Account', 'https://supabase.com/dashboard/account');
    await page.goto('https://supabase.com/dashboard/account', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Выход: ищем меню пользователя и Sign out
    log('Выход из аккаунта...');
    const avatarOrMenu = page.locator('[data-state="open"], button[aria-haspopup="menu"], [data-radix-collection-item]').first();
    const signOutBtn = page.getByRole('menuitem', { name: /sign out|log out|выйти/i }).or(page.getByText(/sign out|log out|sign out/i).first());

    if (await page.locator('button').filter({ has: page.locator('img[alt*="avatar" i], [class*="avatar"]') }).first().isVisible().catch(() => false)) {
      await page.locator('button').filter({ has: page.locator('img[alt*="avatar" i], [class*="avatar"]') }).first().click();
      await page.waitForTimeout(800);
      if (await signOutBtn.isVisible().catch(() => false)) {
        await signOutBtn.click();
      } else {
        const anySignOut = page.getByText(/sign out|log out/i).first();
        if (await anySignOut.isVisible().catch(() => false)) await anySignOut.click();
      }
    } else {
      // Альтернатива: прямой URL выхода если есть
      await page.goto('https://supabase.com/dashboard/sign-in').catch(() => {});
      log('Переход на sign-in (выход через сброс сессии).');
    }

    await page.waitForTimeout(1500);
    log('Цикл завершён.');
  } finally {
    await context.close();
    log('Браузер закрыт.');
  }
}

async function main() {
  log('=== Старт Supabase automation (интервал: 4 дня) ===');
  const run = async () => {
    try {
      await runOnce();
    } catch (e) {
      log('Ошибка:', e.message);
      console.error(e);
    }
    log('Следующий запуск через 4 дня.');
    setTimeout(run, INTERVAL_MS);
  };
  await run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
