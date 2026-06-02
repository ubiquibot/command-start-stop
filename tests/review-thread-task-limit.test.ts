import { describe, expect, jest, test } from "@jest/globals";
import { Context } from "../src/types/context";
import { getPendingOpenedPullRequests } from "../src/utils/issue";

const pullRequest = {
  html_url: "https://github.com/ubiquity/test-repo/pull/7",
  number: 7,
};
const CONTRIBUTOR_REPLY_AT = "2026-01-02T00:00:00.000Z";

function createContext(reviewThreads: unknown[]) {
  const rest = {
    search: {
      issuesAndPullRequests: jest.fn(),
    },
    pulls: {
      listReviews: jest.fn(),
    },
    issues: {
      listEventsForTimeline: jest.fn(),
    },
  };
  return {
    config: {
      assignedIssueScope: "org",
      reviewDelayTolerance: "24 Hours",
      rolesWithReviewAuthority: ["OWNER", "MEMBER"],
    },
    organizations: ["ubiquity"],
    payload: {
      repository: {
        full_name: "ubiquity/test-repo",
      },
    },
    logger: {
      debug: jest.fn(),
      error: (message: string) => new Error(message),
    },
    octokit: {
      rest,
      paginate: jest.fn((endpoint: unknown) => {
        if (endpoint === rest.search.issuesAndPullRequests) {
          return Promise.resolve([pullRequest]);
        }
        if (endpoint === rest.pulls.listReviews) {
          return Promise.resolve([]);
        }
        if (endpoint === rest.issues.listEventsForTimeline) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
      graphql: {
        paginate: jest.fn(() =>
          Promise.resolve({
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: reviewThreads,
                },
              },
            },
          })
        ),
      },
    },
  } as unknown as Context;
}

describe("review thread task limit handling", () => {
  test("does not count a PR when all unresolved threads are waiting on reviewers", async () => {
    const context = createContext([
      {
        isResolved: false,
        comments: {
          nodes: [
            { author: { login: "reviewer" }, createdAt: "2026-01-01T00:00:00.000Z" },
            { author: { login: "alice" }, createdAt: CONTRIBUTOR_REPLY_AT },
          ],
        },
      },
    ]);

    await expect(getPendingOpenedPullRequests(context, "alice")).resolves.toEqual([]);
  });

  test("still counts a PR when an unresolved thread is waiting on the contributor", async () => {
    const context = createContext([
      {
        isResolved: false,
        comments: {
          nodes: [
            { author: { login: "alice" }, createdAt: "2026-01-01T00:00:00.000Z" },
            { author: { login: "reviewer" }, createdAt: CONTRIBUTOR_REPLY_AT },
          ],
        },
      },
    ]);

    await expect(getPendingOpenedPullRequests(context, "alice")).resolves.toEqual([pullRequest]);
  });

  test("ignores resolved review threads", async () => {
    const context = createContext([
      {
        isResolved: true,
        comments: {
          nodes: [{ author: { login: "alice" }, createdAt: CONTRIBUTOR_REPLY_AT }],
        },
      },
    ]);

    await expect(getPendingOpenedPullRequests(context, "alice")).resolves.toEqual([pullRequest]);
  });
});
