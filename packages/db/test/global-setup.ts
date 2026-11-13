import type { TestProject } from "vitest/node";
import { type StartedTestDatabase, startTestDatabase, type TestDatabaseUrls } from "../src/testing/index";

declare module "vitest" {
  interface ProvidedContext {
    db: TestDatabaseUrls;
  }
}

let database: StartedTestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  database = await startTestDatabase();
  project.provide("db", database.urls);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}
