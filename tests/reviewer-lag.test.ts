import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { drop } from "@mswjs/data";
import { Repository } from "@octokit/graphql-schema";
import dotenv from "dotenv";
import { Context } from "../src/types/context";
import { getPendingOpenedPullRequests } from "../src/utils/issue";
import { db } from "./__mocks__/db";
import issueTemplate from "./__mocks__/issue-template";
import { server } from "./__mocks__/node";
import { createContext } from "./utils";

dotenv.config();

beforeAll(() => {
  server.listen();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => server.close());

describe("Reviewer Lag Task Assignment Limit Handling", () => {
  beforeEach(async () => {
    drop(db);
    jest.clearAllMocks();
  });

  it("should consider PR as reviewer-lagged when contributor is last commenter on all unresolved threads after reviewDelayTolerance", async () => {
    const userLogin = "contributor1";
    const now = Date.now();
    const twoDaysAgo = new Date(now - 48 * 3600 * 1000).toISOString();

    const issue = { ...issueTemplate, number: 10 } as unknown as Context<"issue_comment.created">["payload"]["issue"];
    const sender = { id: 1, login: userLogin } as unknown as Context["payload"]["sender"];
    const context = (await createContext(issue, sender, "")) as Context;
    context.config.reviewDelayTolerance = "1 Day";
    context.config.rolesWithReviewAuthority = ["OWNER", "ADMIN", "MEMBER", "COLLABORATOR"] as any;

    const pullRequest = {
      id: 101,
      number: 101,
      html_url: "https://github.com/ubiquity/test-repo/pull/101",
      created_at: twoDaysAgo,
      user: { login: userLogin },
      requested_reviewers: [],
    };

    context.octokit = {
      paginate: jest.fn(async (method: any, params: any) => {
        if (method === context.octokit.rest.search.issuesAndPullRequests) {
          return [pullRequest];
        }
        if (method === context.octokit.rest.pulls.listReviews) {
          return [
            {
              id: 1,
              user: { id: 99, login: "reviewer1" },
              author_association: "COLLABORATOR",
              state: "CHANGES_REQUESTED",
              submitted_at: twoDaysAgo,
            },
          ];
        }
        if (method === context.octokit.rest.issues.listEventsForTimeline) {
          return [{ event: "review_requested", created_at: twoDaysAgo }];
        }
        return [];
      }),
      graphql: {
        paginate: jest.fn(async () => {
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread_1",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            author: { login: "reviewer1" },
                            createdAt: new Date(now - 50 * 3600 * 1000).toISOString(),
                          },
                          {
                            author: { login: userLogin },
                            createdAt: twoDaysAgo, // contributor answered 48h ago
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          };
        }),
      },
      rest: {
        search: { issuesAndPullRequests: jest.fn() },
        pulls: { listReviews: jest.fn() },
        issues: { listEventsForTimeline: jest.fn() },
      },
    } as unknown as Context["octokit"];

    const pendingPrs = await getPendingOpenedPullRequests(context, userLogin);
    // When reviewer-lagged, PR is NOT skipped, meaning it IS included in pendingPrs to offset quota
    expect(pendingPrs).toHaveLength(1);
    expect(pendingPrs[0].number).toBe(101);
  });

  it("should NOT consider PR as reviewer-lagged when reviewer is last commenter on an unresolved thread", async () => {
    const userLogin = "contributor1";
    const now = Date.now();
    const twoDaysAgo = new Date(now - 48 * 3600 * 1000).toISOString();

    const issue = { ...issueTemplate, number: 10 } as unknown as Context<"issue_comment.created">["payload"]["issue"];
    const sender = { id: 1, login: userLogin } as unknown as Context["payload"]["sender"];
    const context = (await createContext(issue, sender, "")) as Context;
    context.config.reviewDelayTolerance = "1 Day";
    context.config.rolesWithReviewAuthority = ["OWNER", "ADMIN", "MEMBER", "COLLABORATOR"] as any;

    const pullRequest = {
      id: 101,
      number: 101,
      html_url: "https://github.com/ubiquity/test-repo/pull/101",
      created_at: twoDaysAgo,
      user: { login: userLogin },
      requested_reviewers: [],
    };

    context.octokit = {
      paginate: jest.fn(async (method: any, params: any) => {
        if (method === context.octokit.rest.search.issuesAndPullRequests) {
          return [pullRequest];
        }
        if (method === context.octokit.rest.pulls.listReviews) {
          return [
            {
              id: 1,
              user: { id: 99, login: "reviewer1" },
              author_association: "COLLABORATOR",
              state: "CHANGES_REQUESTED",
              submitted_at: twoDaysAgo,
            },
          ];
        }
        if (method === context.octokit.rest.issues.listEventsForTimeline) {
          return [{ event: "review_requested", created_at: twoDaysAgo }];
        }
        return [];
      }),
      graphql: {
        paginate: jest.fn(async () => {
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread_1",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            author: { login: userLogin },
                            createdAt: new Date(now - 50 * 3600 * 1000).toISOString(),
                          },
                          {
                            author: { login: "reviewer1" }, // Reviewer was the last commenter!
                            createdAt: twoDaysAgo,
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          };
        }),
      },
      rest: {
        search: { issuesAndPullRequests: jest.fn() },
        pulls: { listReviews: jest.fn() },
        issues: { listEventsForTimeline: jest.fn() },
      },
    } as unknown as Context["octokit"];

    const pendingPrs = await getPendingOpenedPullRequests(context, userLogin);
    // Since reviewer is the last commenter, contributor still has pending feedback -> PR is skipped from offset
    expect(pendingPrs).toHaveLength(0);
  });

  it("should NOT consider PR as reviewer-lagged when contributor commented recently (< reviewDelayTolerance)", async () => {
    const userLogin = "contributor1";
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();

    const issue = { ...issueTemplate, number: 10 } as unknown as Context<"issue_comment.created">["payload"]["issue"];
    const sender = { id: 1, login: userLogin } as unknown as Context["payload"]["sender"];
    const context = (await createContext(issue, sender, "")) as Context;
    context.config.reviewDelayTolerance = "1 Day"; // 24 hours
    context.config.rolesWithReviewAuthority = ["OWNER", "ADMIN", "MEMBER", "COLLABORATOR"] as any;

    const pullRequest = {
      id: 101,
      number: 101,
      html_url: "https://github.com/ubiquity/test-repo/pull/101",
      created_at: twoHoursAgo,
      user: { login: userLogin },
      requested_reviewers: [],
    };

    context.octokit = {
      paginate: jest.fn(async (method: any, params: any) => {
        if (method === context.octokit.rest.search.issuesAndPullRequests) {
          return [pullRequest];
        }
        if (method === context.octokit.rest.pulls.listReviews) {
          return [
            {
              id: 1,
              user: { id: 99, login: "reviewer1" },
              author_association: "COLLABORATOR",
              state: "CHANGES_REQUESTED",
              submitted_at: twoHoursAgo,
            },
          ];
        }
        if (method === context.octokit.rest.issues.listEventsForTimeline) {
          return [{ event: "review_requested", created_at: twoHoursAgo }];
        }
        return [];
      }),
      graphql: {
        paginate: jest.fn(async () => {
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread_1",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            author: { login: "reviewer1" },
                            createdAt: new Date(now - 5 * 3600 * 1000).toISOString(),
                          },
                          {
                            author: { login: userLogin },
                            createdAt: twoHoursAgo, // only 2h ago (< 24h tolerance)
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          };
        }),
      },
      rest: {
        search: { issuesAndPullRequests: jest.fn() },
        pulls: { listReviews: jest.fn() },
        issues: { listEventsForTimeline: jest.fn() },
      },
    } as unknown as Context["octokit"];

    const pendingPrs = await getPendingOpenedPullRequests(context, userLogin);
    // Not enough time has elapsed to qualify as reviewer-lagged
    expect(pendingPrs).toHaveLength(0);
  });
});
