import { expect, test, type Page } from "@playwright/test";

type Hook = {
  scene: { cam: { x: number; y: number; zoom: number }; selection: Set<{ path: string; group: { path: string; mode: string } }>; toWorld(x: number, y: number): { x: number; y: number } };
  session: { own: { items: Record<string, unknown>; groups: Record<string, { mode: string }> }; board: { items: Map<string, { path: string; wx: number; wy: number; ww: number; wh: number; group: { path: string; mode: string } }>; groups: Map<string, { wx: number; wy: number; w: number; h: number }> } };
};

async function open(page: Page, n = 300) {
  await page.goto(`/?n=${n}&stats`);
  await expect(page.getByText(`${n.toLocaleString("en-US")} images`)).toBeVisible();
  await page.waitForFunction(() => "__locus" in window);
}

/** Screen position (page coords) of an image's center. */
async function centerOf(page: Page, path: string) {
  return page.evaluate((p) => {
    const { scene, session } = (window as unknown as { __locus: Hook }).__locus;
    const it = session.board.items.get(p)!;
    const host = document.querySelector("[data-testid=canvas]")!.getBoundingClientRect();
    return { x: host.left + (it.wx + it.ww / 2 - scene.cam.x) * scene.cam.zoom, y: host.top + (it.wy + it.wh / 2 - scene.cam.y) * scene.cam.zoom };
  }, path);
}

async function groupCenter(page: Page, path: string) {
  return page.evaluate((p) => {
    const { scene, session } = (window as unknown as { __locus: Hook }).__locus;
    const g = session.board.groups.get(p)!;
    const host = document.querySelector("[data-testid=canvas]")!.getBoundingClientRect();
    return { x: host.left + (g.wx + g.w * 0.5 - scene.cam.x) * scene.cam.zoom, y: host.top + (g.wy + g.h * 0.6 - scene.cam.y) * scene.cam.zoom };
  }, path);
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, alt = false) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

test("shows every folder as a box with its name and count", async ({ page }) => {
  await open(page);
  await expect(page.locator(".group-label:not([hidden])").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Folders" }).getByText("Storyboards")).toBeVisible();
  await expect(page.getByTestId("stats")).toContainText("300 visible");
});

test("search dims the rest and Enter flies to each match", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+f");
  await page.keyboard.type("seq_020");
  const count = Number(await page.locator(".search-count").textContent());
  expect(count).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  const selected = await page.evaluate(() => [...(window as unknown as { __locus: Hook }).__locus.scene.selection].map((i) => i.path));
  expect(selected).toHaveLength(1);
  expect(selected[0]).toContain("Seq 020");
});

test("dragging an image inside its box makes the box Free and saves the spot", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Mood/ }).click();
  await page.waitForTimeout(300);
  const path = "Mood/mood_001.jpg";
  const c = await centerOf(page, path);
  await drag(page, c, { x: c.x + 40, y: c.y + 260 });
  const state = await page.evaluate((p) => {
    const { session } = (window as unknown as { __locus: Hook }).__locus;
    return { mode: session.board.items.get(p)!.group.mode, saved: p in session.own.items, groupSaved: session.own.groups["Mood"]?.mode };
  }, path);
  expect(state).toEqual({ mode: "free", saved: true, groupSaved: "free" });
});

test("dropping an image on another folder moves the file, and Undo moves it back", async ({ page }) => {
  await open(page);
  const path = "Mood/mood_002.jpg";
  const from = await centerOf(page, path);
  const to = await groupCenter(page, "Props");
  await drag(page, from, to);
  await expect(page.getByRole("status")).toContainText("Moved mood_002.jpg to Props");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __locus: Hook }).__locus.session.board.items.has("Props/mood_002.jpg"))).toBe(true);
  await page.keyboard.press("Control+z");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __locus: Hook }).__locus.session.board.items.has("Mood/mood_002.jpg"))).toBe(true);
});

test("a board of 3,000 images opens and stays interactive", async ({ page }) => {
  const started = Date.now();
  await open(page, 3000);
  await expect(page.getByTestId("stats")).toContainText("3,000 visible");
  const opened = Date.now() - started;
  console.log(`3,000 images on screen in ${opened} ms (software rendering)`);
  const box = (await page.getByTestId("canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, -120);
  await expect(page.getByTestId("stats")).not.toContainText("3,000 visible");
});

test("online-only images download by themselves and take their real shape", async ({ page }) => {
  await page.goto(`/?n=400&cloud=0.7&stats`);
  await page.waitForFunction(() => "__locus" in window);
  const status = page.getByTestId("cloud-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText("left");

  // Pausing stops the background downloads; resuming finishes them.
  await status.getByRole("button", { name: "Pause" }).click();
  await expect(status).toContainText("Downloads paused");
  await page.waitForTimeout(600); // downloads already running finish
  const pausedAt = await status.textContent();
  await page.waitForTimeout(1000);
  await expect(status).toHaveText(pausedAt!);
  await status.getByRole("button", { name: "Resume" }).click();
  await expect(status).toBeHidden({ timeout: 30_000 });

  // Every image now has its real size and a non-square shape where it should.
  const shapes = await page.evaluate(() => {
    const { session } = (window as unknown as { __locus: { session: { board: { items: Map<string, { aspect: number; img: { width: number; height: number; onlineOnly: boolean } }> } } } }).__locus;
    const all = [...session.board.items.values()];
    return {
      unknown: all.filter((it) => !it.img.width).length,
      wrong: all.filter((it) => Math.abs(it.aspect - it.img.width / it.img.height) > 0.02).length,
      square: all.filter((it) => Math.abs(it.aspect - 1) < 0.01).length
    };
  });
  expect(shapes.unknown).toBe(0);
  expect(shapes.wrong).toBe(0);
  expect(shapes.square).toBeLessThan(120);
});
