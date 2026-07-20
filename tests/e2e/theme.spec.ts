import { expect, test } from "@playwright/test";

test("主题支持系统、浅色、深色三态并仅保存非内容偏好", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("./", { waitUntil: "networkidle" });

  const theme = page.getByLabel("主题模式");
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");

  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("online-tools-hub:theme")),
    )
    .toBe("light");

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByLabel("主题模式")).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByLabel("主题模式").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByLabel("主题模式").selectOption("system");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("online-tools-hub:theme")),
    )
    .toBeNull();
});

test("减少动态效果偏好会关闭动画与平滑滚动", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const motion = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".tool-card");
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });

  expect(motion).not.toBeNull();
  expect(motion?.animationDuration).toMatch(/^(?:0s|0\.01ms)$/u);
  expect(motion?.transitionDuration).toMatch(/^(?:0s|0\.01ms)$/u);
  expect(motion?.scrollBehavior).toBe("auto");
});
