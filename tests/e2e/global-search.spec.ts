import { expect, test } from "@playwright/test";

test("全站工具搜索支持按钮、键盘快捷键和直接跳转", async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });

  const trigger = page.getByRole("button", { name: "搜索工具" });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "搜索全部工具" });
  await expect(dialog).toBeVisible();

  const input = dialog.getByRole("searchbox", { name: "搜索工具" });
  await input.fill("图片压缩");
  const imageTool = dialog.getByRole("link", { name: /图片压缩/u });
  await expect(imageTool).toHaveCount(1);
  await imageTool.click();
  await expect(page).toHaveURL(/\/tools\/image-compressor\/$/u);

  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
