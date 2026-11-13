import { randomBytes } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * Task 1.7 acceptance: invite a member, change their role, create and revoke a key, through the
 * Studio against the real api. Each run uses fresh accounts, so it can repeat on the same database.
 */
const run = randomBytes(4).toString("hex");
const PASSWORD = `e2e only ${run} pw`;

async function signUp(browser: Browser, name: string, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  return page;
}

test("an owner invites a member, changes their role, and creates and revokes a key", async ({ browser }) => {
  // Two accounts, scrypt hashing on each sign-up, and a dozen screens: longer than the 30 s default.
  test.setTimeout(120_000);
  const ownerEmail = `owner-${run}@example.test`;
  const memberEmail = `member-${run}@example.test`;

  // Owner: sign up, create the workspace.
  const owner = await signUp(browser, "مالك Owner", ownerEmail);
  await expect(owner.getByRole("heading", { name: "New workspace" })).toBeVisible();
  await owner.getByLabel("Name").fill(`E2E ${run}`);
  await owner.getByRole("button", { name: "Create workspace" }).click();
  await expect(owner.getByRole("heading", { name: "Bots" })).toBeVisible();
  await expect(owner.getByText("No bots yet")).toBeVisible();

  // Invite the member; the link is shown once.
  await owner.getByRole("link", { name: "Settings" }).click();
  await owner.getByRole("link", { name: "Members" }).click();
  await owner.getByRole("button", { name: "Invite member" }).first().click();
  const invite = owner.getByRole("dialog");
  await invite.getByLabel("Email").fill(memberEmail);
  await invite.getByLabel("Role").selectOption("builder");
  await invite.getByRole("button", { name: "Invite member" }).click();
  const link = await invite.getByLabel("Invitation link").inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await invite.getByRole("button", { name: "Done" }).click();
  await expect(owner.getByRole("table", { name: "Pending invitations" })).toContainText(memberEmail);

  // Member: sign up from the link, join.
  const path = new URL(link).pathname;
  const member = await (await browser.newContext()).newPage();
  await member.goto(path);
  await member.getByRole("link", { name: "Create an account" }).click();
  await member.getByLabel("Name").fill("عضو Member");
  await member.getByLabel("Email").fill(memberEmail);
  await member.getByLabel("Password").fill(PASSWORD);
  await member.getByRole("button", { name: "Create account" }).click();
  await member.getByRole("button", { name: "Join workspace" }).click();
  await expect(member.getByRole("heading", { name: "Bots" })).toBeVisible();

  // Owner: the member is listed as Builder; change to Viewer.
  await owner.reload();
  const members = owner.getByRole("table", { name: "Members" });
  await expect(members).toContainText(memberEmail);
  const role = owner.getByLabel("Role of عضو Member");
  await expect(role).toHaveValue("builder");
  await role.selectOption("viewer");
  await owner.reload();
  await expect(owner.getByLabel("Role of عضو Member")).toHaveValue("viewer");

  // The viewer sees no API keys tab actions and cannot invite.
  await member.goto(
    owner
      .url()
      .replace(/^https?:\/\/[^/]+/, "")
      .replace("/members", "/api-keys"),
  );
  await expect(member.getByText("Only owners and admins manage API keys")).toBeVisible();

  // Owner: create a key, see it once, revoke it.
  await owner.getByRole("link", { name: "API keys" }).click();
  await owner.getByRole("button", { name: "New API key" }).first().click();
  const create = owner.getByRole("dialog");
  await create.getByLabel("Name").fill("CI");
  await create.getByRole("button", { name: "Create key" }).click();
  const key = await create.getByTestId("new-api-key").inputValue();
  expect(key).toMatch(/^wk_live_[0-9a-z]{8}_[A-Za-z0-9_-]{43}$/);
  await create.getByRole("button", { name: "Done" }).click();

  // The key works against the api, then stops working once revoked.
  const workspaceId = new URL(owner.url()).pathname.split("/")[2];
  const call = () =>
    owner.request.get(`/v1/workspaces/${workspaceId}`, { headers: { authorization: `Bearer ${key}` } });
  expect((await call()).status()).toBe(200);
  const keys = owner.getByRole("table", { name: "API keys" });
  await expect(keys).toContainText(key.slice(0, 16));
  await expect(keys).not.toContainText(key.slice(-20));
  await keys.getByRole("button", { name: "Revoke" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(keys.getByText("Revoked")).toBeVisible();
  expect((await call()).status()).toBe(401);
});
