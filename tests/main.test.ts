import { drop } from "@mswjs/data";
import { Context, SupportedEventsU } from "../src/types";
import { db } from "./__mocks__/db";
import { server } from "./__mocks__/node";
import usersGet from "./__mocks__/users-get.json";
import { expect, describe, beforeAll, beforeEach, afterAll, afterEach } from "@jest/globals";
import { userStartStop } from "../src/handlers/user-start-stop";
import issueTemplate from "./__mocks__/issue-template";
import { createAdapters } from "../src/adapters";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Logs, cleanLogString } from "@ubiquity-dao/ubiquibot-logger";
dotenv.config();

type Issue = Context["payload"]["issue"];
type PayloadSender = Context["payload"]["sender"];

const octokit = jest.requireActual("@octokit/rest");
const TEST_REPO = "ubiquity/test-repo";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  drop(db);
  server.resetHandlers();
});
afterAll(() => server.close());

describe("User start/stop", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    await setupTests();
  });

  test("User can start an issue", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender);

    context.adapters = createAdapters(getSupabase(), context);

    const { output } = await userStartStop(context);

    expect(output).toEqual("Task assigned successfully");
  });

  test("User can stop an issue", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 2 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 2 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/stop");

    context.adapters = createAdapters(getSupabase(), context);

    const { output } = await userStartStop(context);

    expect(output).toEqual("Task unassigned successfully");
  });

  test("Stopping an issue should close the author's linked PR", async () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    const issue = db.issue.findFirst({ where: { id: { equals: 2 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 2 } } }) as unknown as PayloadSender;
    const context = createContext(issue, sender, "/stop");

    context.adapters = createAdapters(getSupabase(), context);

    const { output } = await userStartStop(context);

    expect(output).toEqual("Task unassigned successfully");
    const logs = infoSpy.mock.calls.flat();
    expect(logs[0]).toMatch(/Opened prs/);
    expect(cleanLogString(logs[3])).toMatch(
      cleanLogString(
        " › ```diff# These linked pull requests are closed:  http://github.com/ubiquity/test-repo/pull/2  http://github.com/ubiquity/test-repo/pull/3"
      )
    );
  });

  test("User can't stop an issue they're not assigned to", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 2 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/stop");

    context.adapters = createAdapters(getSupabase(), context);

    const output = await userStartStop(context);

    expect(output).toEqual({ output: "You are not assigned to this task" });
  });

  test("User can't stop an issue without assignees", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 6 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/stop");

    context.adapters = createAdapters(getSupabase(), context);

    const output = await userStartStop(context);

    expect(output).toEqual({ output: "You are not assigned to this task" });
  });

  test("User can't start an issue that's already assigned", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 2 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/start");

    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("Issue is already assigned");
  });

  test("User can't start an issue without a price label", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 3 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender);

    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("No price label is set to calculate the duration");
  });

  test("User can't start an issue without a wallet address", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender);

    context.adapters = createAdapters(getSupabase(false), context);
    await expect(userStartStop(context)).rejects.toThrow("No wallet address found");
  });

  test("User can't start an issue that's closed", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 4 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender);

    context.adapters = createAdapters(getSupabase(), context);
    await expect(userStartStop(context)).rejects.toThrow("Issue is closed");
  });

  test("User can't start an issue that's a parent issue", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 5 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/start");

    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("Issue is a parent issue");
  });

  test("User can't start another issue if they have reached the max limit", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 2 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender);
    context.config.miscellaneous.maxConcurrentTasks = 2;

    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("Too many assigned issues, you have reached your max limit of 2 issues.");
  });

  test("User can't start an issue if they have previously been unassigned by an admin", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 2 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 2 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/start");
    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("User was previously unassigned from this task");
  });

  test("Should throw if no APP_ID is set", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/start", null);

    context.env.APP_ID = null as unknown as string;
    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("Invalid APP_ID");
  });

  test("Should throw if APP_ID is not a number", async () => {
    const issue = db.issue.findFirst({ where: { id: { equals: 1 } } }) as unknown as Issue;
    const sender = db.users.findFirst({ where: { id: { equals: 1 } } }) as unknown as PayloadSender;

    const context = createContext(issue, sender, "/start", "testing-one");
    context.adapters = createAdapters(getSupabase(), context);

    await expect(userStartStop(context)).rejects.toThrow("Invalid APP_ID");
  });
});

async function setupTests() {
  for (const item of usersGet) {
    db.users.create(item);
  }

  db.repo.create({
    id: 1,
    html_url: "",
    name: "test-repo",
    owner: {
      login: "ubiquity",
      id: 1,
    },
    issues: [],
  });

  db.issue.create({
    ...issueTemplate,
  });

  db.issue.create({
    ...issueTemplate,
    id: 2,
    node_id: "MDU6SXNzdWUy",
    title: "Second issue",
    number: 2,
    body: "Second issue body",
    assignee: {
      id: 2,
      login: "user2",
    },
    assignees: [
      {
        id: 2,
        login: "user2",
      },
    ],
    owner: "ubiquity",
  });

  db.issue.create({
    ...issueTemplate,
    id: 3,
    node_id: "MDU6SXNzdWUy",
    title: "Third issue",
    number: 3,
    labels: [],
    body: "Third issue body",
    owner: "ubiquity",
  });

  db.issue.create({
    ...issueTemplate,
    id: 4,
    node_id: "MDU6SXNzdWUy",
    title: "Fourth issue",
    number: 4,
    body: "Fourth issue body",
    owner: "ubiquity",
    state: "closed",
  });

  db.issue.create({
    ...issueTemplate,
    id: 5,
    node_id: "MDU6SXNzdWUy",
    title: "Fifth issue",
    number: 5,
    body: "- [x] #1\n- [ ] #2",
    owner: "ubiquity",
  });

  db.issue.create({
    ...issueTemplate,
    id: 6,
    node_id: "MDU6SXNzdWUg",
    title: "Sixth issue",
    number: 5,
    body: "Sixth issue body",
    owner: "ubiquity",
    assignees: [],
  });

  db.pull.create({
    id: 1,
    html_url: "https://github.com/ubiquity/test-repo/pull/1",
    number: 1,
    author: {
      id: 2,
      name: "user2",
    },
    user: {
      id: 2,
      login: "user2",
    },
    body: "Pull body",
    owner: "ubiquity",
    repo: "test-repo",
    state: "open",
    closed_at: null,
  });

  db.pull.create({
    id: 2,
    html_url: "https://github.com/ubiquity/test-repo/pull/2",
    number: 2,
    author: {
      id: 2,
      name: "user2",
    },
    user: {
      id: 2,
      login: "user2",
    },
    body: "Pull request",
    owner: "ubiquity",
    repo: "test-repo",
    state: "open",
    closed_at: null,
  });

  db.pull.create({
    id: 3,
    html_url: "https://github.com/ubiquity/test-repo/pull/3",
    number: 3,
    author: {
      id: 1,
      name: "ubiquity",
    },
    user: {
      id: 1,
      login: "ubiquity",
    },
    body: "Pull request body",
    owner: "ubiquity",
    repo: "test-repo",
    state: "open",
    closed_at: null,
  });

  db.review.create({
    id: 1,
    body: "Review body",
    commit_id: "123",
    html_url: "",
    pull_request_url: "",
    state: "APPROVED",
    submitted_at: new Date().toISOString(),
    user: {
      id: 1,
      name: "ubiquity",
    },
    pull_number: 1,
  });

  const CROSS_REFERENCED = "cross-referenced";

  db.event.create({
    id: 1,
    created_at: new Date().toISOString(),
    actor: {
      id: 2,
      name: "user2",
      login: "user2",
      type: "User",
    },
    commit_id: "123",
    commit_url: "",
    event: CROSS_REFERENCED,
    issue_number: 1,
    owner: "ubiquity",
    repo: "test-repo",
    source: {
      issue: {
        number: 10,
        state: "open",
        body: `Resolves #2`,
        html_url: "https://github.com/ubiquity/test-repo/pull/10",
        repository: {
          full_name: TEST_REPO,
        },
        user: {
          login: "ubiquity",
        },
        pull_request: {
          html_url: "https://github.com/ubiquity/test-repo/pull/10",
        },
      },
    },
  });

  db.event.create({
    id: 2,
    actor: {
      id: 1,
      name: "ubiquity",
      login: "ubiquity",
      type: "User",
    },
    commit_id: "123",
    commit_url: "",
    created_at: new Date().toISOString(),
    event: CROSS_REFERENCED,
    issue_number: 2,
    owner: "ubiquity",
    repo: "test-repo",
    source: {
      issue: {
        number: 2,
        state: "open",
        body: `Resolves #2`,
        html_url: "http://github.com/ubiquity/test-repo/pull/2",
        repository: {
          full_name: TEST_REPO,
        },
        user: {
          login: "user2",
        },
        pull_request: {
          html_url: "http://github.com/ubiquity/test-repo/pull/2",
        },
      },
    },
  });

  db.event.create({
    id: 3,
    commit_id: "123",
    commit_url: "",
    created_at: new Date().toISOString(),
    event: CROSS_REFERENCED,
    issue_number: 2,
    owner: "ubiquity",
    repo: "test-repo",
    source: {
      issue: {
        number: 3,
        state: "open",
        body: `Resolves #2`,
        html_url: "http://github.com/ubiquity/test-repo/pull/3",
        repository: {
          full_name: TEST_REPO,
        },
        user: {
          login: "user2",
        },
        pull_request: {
          html_url: "http://github.com/ubiquity/test-repo/pull/3",
        },
      },
    },
  });

  db.event.create({
    id: 4,
    actor: {
      id: 1,
      login: "ubiquity",
      type: "User",
    },
    assignee: {
      login: "user2",
    },
    created_at: new Date().toISOString(),
    event: "assigned",
    issue_number: 2,
    owner: "ubiquity",
    repo: "test-repo",
  });

  db.event.create({
    id: 5,
    actor: {
      id: 1,
      login: "ubiquibot[bot]",
      type: "Bot",
    },
    assignee: {
      login: "user2",
    },
    created_at: new Date().toISOString(),
    event: "assigned",
    issue_number: 2,
    owner: "ubiquity",
    repo: "test-repo",
  });

  db.event.create({
    id: 6,
    actor: {
      id: 1,
      login: "ubiquity",
      type: "User",
    },
    assignee: {
      login: "user2",
    },
    created_at: new Date().toISOString(),
    event: "unassigned",
    issue_number: 2,
    owner: "ubiquity",
    repo: "test-repo",
  });
}

function createContext(issue: Record<string, unknown>, sender: Record<string, unknown>, body = "/start", appId: string | number | null = "1"): Context {
  return {
    adapters: {} as ReturnType<typeof createAdapters>,
    payload: {
      issue: issue as unknown as Context["payload"]["issue"],
      sender: sender as unknown as Context["payload"]["sender"],
      repository: db.repo.findFirst({ where: { id: { equals: 1 } } }) as unknown as Context["payload"]["repository"],
      comment: { body } as unknown as Context["payload"]["comment"],
      action: "created",
      installation: { id: 1 } as unknown as Context["payload"]["installation"],
      organization: { login: "ubiquity" } as unknown as Context["payload"]["organization"],
    },
    logger: new Logs("debug"),
    config: {
      timers: {
        reviewDelayTolerance: 86000,
        taskStaleTimeoutDuration: 2580000,
      },
      miscellaneous: {
        maxConcurrentTasks: 10,
        startRequiresWallet: true,
      },
    },
    octokit: new octokit.Octokit(),
    eventName: "issue_comment.created" as SupportedEventsU,
    env: {
      SUPABASE_KEY: "key",
      SUPABASE_URL: "url",
      APP_ID: appId as string,
    },
  };
}

function getSupabase(withData = true) {
  const mockedTable = {
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: withData
            ? {
                id: 1,
                wallets: {
                  address: "0x123",
                },
              }
            : {
                id: 1,
                wallets: {
                  address: undefined,
                },
              },
        }),
      }),
    }),
  };

  const mockedSupabase = {
    from: jest.fn().mockReturnValue(mockedTable),
  };

  return mockedSupabase as unknown as ReturnType<typeof createClient>;
}
