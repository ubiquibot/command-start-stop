import { describe, expect, it, jest } from "@jest/globals";
import { Context } from "../src/types/context";
import { getPendingOpenedPullRequests } from "../src/utils/issue";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function createPullRequestContext(thread: unknown): Context {
  const pullRequest = {
    html_url: "https://github.com/ubiquity/test-repo/pull/7",
    number: 7,
    created_at: new Date(Date.now() - THREE_DAYS_MS * 2).toISOString(),
    requested_reviewers: [],
    user: {
      id: 2,
      login: "contributor",
    },
  };
  const review = {
    author_association: "MEMBER",
    state: "CHANGES_REQUESTED",
    submitted_at: new Date(Date.now() - THREE_DAYS_MS * 2).toISOString(),
    user: {
      id: 1,
      login: "reviewer",
    },
  };

  return {
    config: {
      assignedIssueScope: "org",
      reviewDelayTolerance: "3 Days",
      rolesWithReviewAuthority: ["MEMBER", "OWNER", "ADMIN"],
    },
    organizations: ["ubiquity"],
    payload: {
      repository: {
        full_name: "ubiquity/test-repo",
      },
    },
    logger: {
      debug: jest.fn(),
      error: jest.fn((message: string) => new Error(message)),
    },
    octokit: {
      paginate: jest.fn((endpoint: unknown) => {
        if (endpoint === context.octokit.rest.search.issuesAndPullRequests) {
          return Promise.resolve([pullRequest]);
        }
        if (endpoint === context.octokit.rest.pulls.listReviews) {
          return Promise.resolve([review]);
        }
        if (endpoint === context.octokit.rest.issues.listEventsForTimeline) {
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
                  nodes: [thread],
                },
              },
            },
          })
        ),
      },
      rest: {
        search: {
          issuesAndPullRequests: jest.fn(),
        },
        pulls: {
          listReviews: jest.fn(),
        },
        issues: {
          listEventsForTimeline: jest.fn(),
        },
      },
    },
  } as unknown as Context;
}

let context: Context;

function createThread({ author, ageMs, isResolved = false }: { author: string; ageMs: number; isResolved?: boolean }) {
  return {
    isResolved,
    comments: {
      nodes: [
        {
          author: {
            login: "reviewer",
          },
          createdAt: new Date(Date.now() - THREE_DAYS_MS * 2).toISOString(),
        },
        {
          author: {
            login: author,
          },
          createdAt: new Date(Date.now() - ageMs).toISOString(),
        },
      ],
    },
  };
}

describe("review-lagged pull requests", () => {
  it("does not count a pull request against the task limit when the assignee has the last stale unresolved-thread comment", async () => {
    context = createPullRequestContext(createThread({ author: "contributor", ageMs: THREE_DAYS_MS + 1000 }));

    await expect(getPendingOpenedPullRequests(context, "contributor")).resolves.toHaveLength(0);
  });

  it("continues counting a pull request when a reviewer has the last unresolved-thread comment", async () => {
    context = createPullRequestContext(createThread({ author: "reviewer", ageMs: THREE_DAYS_MS + 1000 }));

    await expect(getPendingOpenedPullRequests(context, "contributor")).resolves.toHaveLength(1);
  });

  it("continues counting a pull request when the assignee responded before the review delay tolerance elapsed", async () => {
    context = createPullRequestContext(createThread({ author: "contributor", ageMs: 1000 }));

    await expect(getPendingOpenedPullRequests(context, "contributor")).resolves.toHaveLength(1);
  });
});
