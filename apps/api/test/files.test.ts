import { randomBytes } from "node:crypto";
import { CreateFileResponse, FileResponse, PresignedRequest } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, type Stack, signUp, startStack } from "./stack";

/**
 * Task 8.1 through the api (ADR-039): uploads are announced, presigned, then completed against what
 * the object store holds; type and size limits; another workspace can neither see nor finish them.
 */
let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

const slug = () => `f-${randomBytes(4).toString("hex")}`;

async function workspace(owner?: Browser) {
  const user = owner ?? (await signUp(stack.app));
  const ws = (await user.send("POST", "/v1/workspaces", { name: "Files", slug: slug() })).json().id as string;
  const botId = (await user.send("POST", `/v1/workspaces/${ws}/bots`, { name: "دليل", slug: slug() })).json()
    .id as string;
  return { user, ws, botId };
}

const announce = (b: Browser, ws: string, body: Record<string, unknown>) =>
  b.send("POST", `/v1/workspaces/${ws}/files`, { purpose: "kb_source", ...body });

describe("file uploads", () => {
  test("announce, upload, complete, download: the key is the platform's, not the client's", async () => {
    const { user, ws, botId } = await workspace();
    const res = await announce(user, ws, { name: "دليل المنتج.pdf", mime: "application/pdf", size: 5, botId });
    expect(res.statusCode, res.body).toBe(201);
    const { file, upload } = CreateFileResponse.parse(res.json());
    expect(file).toMatchObject({ status: "pending", botId, name: "دليل المنتج.pdf", size: 5 });
    expect(upload.method).toBe("PUT");
    expect(upload.headers).toEqual({ "content-type": "application/pdf" });
    expect(upload.url).toContain(`ws/${ws}/files/${file.id}`);

    // Finishing before the bytes arrived is refused.
    const early = await user.send("POST", `/v1/workspaces/${ws}/files/${file.id}/complete`);
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("upload_incomplete");
    expect((await user.get(`/v1/workspaces/${ws}/files/${file.id}/download`)).statusCode).toBe(409);

    await stack.objectStore.put(`ws/${ws}/files/${file.id}`, new TextEncoder().encode("%PDF-"), "application/pdf");
    const done = await user.send("POST", `/v1/workspaces/${ws}/files/${file.id}/complete`);
    expect(done.statusCode, done.body).toBe(200);
    expect(FileResponse.parse(done.json()).status).toBe("ready");
    // Completing twice is safe.
    expect((await user.send("POST", `/v1/workspaces/${ws}/files/${file.id}/complete`)).statusCode).toBe(200);

    const log = await user.get(`/v1/workspaces/${ws}/audit-log?limit=200`);
    const actions = log.json().data.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a.startsWith("file."))).toEqual(["file.uploaded", "file.created"]);

    const dl = await user.get(`/v1/workspaces/${ws}/files/${file.id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(PresignedRequest.parse(dl.json()).method).toBe("GET");
  });

  test("a different size or type in the store than announced is not ready", async () => {
    const { user, ws } = await workspace();
    const { file } = CreateFileResponse.parse(
      (await announce(user, ws, { name: "a.txt", mime: "text/plain", size: 10 })).json(),
    );
    const key = `ws/${ws}/files/${file.id}`;
    await stack.objectStore.put(key, new Uint8Array(9), "text/plain");
    expect((await user.send("POST", `/v1/workspaces/${ws}/files/${file.id}/complete`)).statusCode).toBe(409);
    await stack.objectStore.put(key, new Uint8Array(10), "application/pdf");
    expect((await user.send("POST", `/v1/workspaces/${ws}/files/${file.id}/complete`)).statusCode).toBe(409);
    await stack.objectStore.put(key, new Uint8Array(10), "text/plain; charset=utf-8");
    expect((await user.send("POST", `/v1/workspaces/${ws}/files/${file.id}/complete`)).statusCode).toBe(200);
  });

  test.each([
    ["an executable", { name: "x.exe", mime: "application/x-msdownload", size: 10 }, "mime"],
    ["a zip", { name: "x.zip", mime: "application/zip", size: 10 }, "mime"],
    ["over 50 MB", { name: "big.pdf", mime: "application/pdf", size: 50 * 1024 * 1024 + 1 }, "size"],
    ["an empty file", { name: "e.pdf", mime: "application/pdf", size: 0 }, "size"],
    ["no name", { name: "  ", mime: "application/pdf", size: 1 }, "name"],
  ])("refuses %s", async (_label, body, path) => {
    const { user, ws } = await workspace();
    const res = await announce(user, ws, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe(path);
  });

  test("exactly 50 MB and a type with parameters are accepted", async () => {
    const { user, ws } = await workspace();
    expect(
      (await announce(user, ws, { name: "big.pdf", mime: "application/pdf", size: 50 * 1024 * 1024 })).statusCode,
    ).toBe(201);
    const res = await announce(user, ws, { name: "n.md", mime: "Text/Markdown; charset=UTF-8", size: 3 });
    expect(res.statusCode).toBe(201);
    expect(res.json().file.mime).toBe("text/markdown");
  });

  test("a viewer can read but not upload", async () => {
    const { user, ws } = await workspace();
    const viewer = await signUp(stack.app);
    const inv = await user.send("POST", `/v1/workspaces/${ws}/invitations`, { email: viewer.email, role: "viewer" });
    const token = new URL(inv.json().acceptUrl).pathname.split("/").pop();
    expect((await viewer.send("POST", "/v1/invitations/accept", { token })).statusCode).toBe(200);
    expect((await announce(viewer, ws, { name: "a.pdf", mime: "application/pdf", size: 1 })).statusCode).toBe(403);
    const { file } = (await announce(user, ws, { name: "a.pdf", mime: "application/pdf", size: 1 })).json();
    expect((await viewer.get(`/v1/workspaces/${ws}/files/${file.id}`)).statusCode).toBe(200);
  });

  test("two tenants: another workspace cannot see, complete or download a file, nor attach one to a foreign bot", async () => {
    const a = await workspace();
    const b = await workspace();
    const { file } = CreateFileResponse.parse(
      (await announce(a.user, a.ws, { name: "a.pdf", mime: "application/pdf", size: 1 })).json(),
    );
    await stack.objectStore.put(`ws/${a.ws}/files/${file.id}`, new Uint8Array(1), "application/pdf");
    // B through its own workspace path with A's file id.
    expect((await b.user.get(`/v1/workspaces/${b.ws}/files/${file.id}`)).statusCode).toBe(404);
    expect((await b.user.send("POST", `/v1/workspaces/${b.ws}/files/${file.id}/complete`)).statusCode).toBe(404);
    expect((await b.user.get(`/v1/workspaces/${b.ws}/files/${file.id}/download`)).statusCode).toBe(404);
    // B through A's workspace path.
    expect((await b.user.get(`/v1/workspaces/${a.ws}/files/${file.id}`)).statusCode).toBe(404);
    // B naming A's bot.
    const res = await announce(b.user, b.ws, { name: "x.pdf", mime: "application/pdf", size: 1, botId: a.botId });
    expect(res.statusCode).toBe(404);
    // A's file is still pending: B's attempts changed nothing.
    expect((await a.user.get(`/v1/workspaces/${a.ws}/files/${file.id}`)).json().status).toBe("pending");
  });

  test("a malformed file id is not found", async () => {
    const { user, ws } = await workspace();
    expect((await user.get(`/v1/workspaces/${ws}/files/not-an-id`)).statusCode).toBe(404);
  });
});
