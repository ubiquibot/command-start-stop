import { expect, jest, test } from "@jest/globals";
import { Context } from "../src/types/context";
import { AssignedIssueScope, Role } from "../src/types/plugin-input";
import { getPendingOpenedPullRequests } from "../src/utils/issue";

const searchIssuesAndPullRequests = jest.fn();
const listReviews = jest.fn();
const listEventsForTimeline = jest.fn();

interface ReviewThreadNode {
  isResolved: boolean;
  comments: {
    nodes: {
      author: {
        login: string;
      } | null;
      createdAt: string;
    }[];
  };
}

interface CreateContextOptions {
  pullRequestCreatedAt: string;
  reviewThreads?: ReviewThreadNode[];
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function reviewThread(author: string, createdAt: string): ReviewThreadNode {
  return {
    isResolved: false,
    comments: {
      nodes: [
        {
          author: {
            login: author,
          },
          createdAt,
        },
      ],
    },
  };
}

function createContext({ pullRequestCreatedAt, reviewThreads = [] }: CreateContextOptions) {
  const pullRequest = {
    number: 42,
    html_url: "https://github.com/ubiquity/test-repo/pull/42",
    created_at: pullRequestCreatedAt,
    requested_reviewers: [],
  };
  const graphqlPaginate = jest.fn(async () => ({
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: reviewThreads,
        },
      },
    },
  }));
  const paginate = jest.fn(async (endpoint: unknown) => {
    if (endpoint === searchIssuesAndPullRequests) {
      return [pullRequest];
    }
    if (endpoint === listReviews || endpoint === listEventsForTimeline) {
      return [];
    }
    throw new Error("Unexpected paginated endpoint");
  });
  const context = {
    config: {
      assignedIssueScope: AssignedIssueScope.ORG,
      reviewDelayTolerance: "1 Day",
      rolesWithReviewAuthority: [Role.ADMIN, Role.OWNER, Role.MEMBER],
    },
    logger: {
      debug: jest.fn(),
      error: jest.fn((message: string) => new Error(message)),
    },
    octokit: {
      graphql: {
        paginate: graphqlPaginate,
      },
      paginate,
      rest: {
        issues: {
          listEventsForTimeline,
        },
        pulls: {
          listReviews,
        },
        search: {
          issuesAndPullRequests: searchIssuesAndPullRequests,
        },
      },
    },
    organizations: ["ubiquity"],
    payload: {
      repository: {
        full_name: "ubiquity/test-repo",
      },
    },
  } as unknown as Context;

  return {
    context,
    pullRequest,
  };
}

test("counts an old PR with addressed unresolved review threads as pending reviewer feedback", async () => {
  const { context, pullRequest } = createContext({
    pullRequestCreatedAt: hoursAgo(72),
    reviewThreads: [reviewThread("user2", hoursAgo(25))],
  });

  await expect(getPendingOpenedPullRequests(context, "user2")).resolves.toEqual([pullRequest]);
});

test("does not count an addressed unresolved review thread before the review delay", async () => {
  const { context } = createContext({
    pullRequestCreatedAt: hoursAgo(72),
    reviewThreads: [reviewThread("user2", hoursAgo(2))],
  });

  await expect(getPendingOpenedPullRequests(context, "user2")).resolves.toEqual([]);
});

test("does not count unresolved review threads when the reviewer is the latest commenter", async () => {
  const { context } = createContext({
    pullRequestCreatedAt: hoursAgo(72),
    reviewThreads: [reviewThread("maintainer", hoursAgo(25))],
  });

  await expect(getPendingOpenedPullRequests(context, "user2")).resolves.toEqual([]);
});

test("counts old no-review PRs after the review delay", async () => {
  const { context, pullRequest } = createContext({
    pullRequestCreatedAt: hoursAgo(25),
  });

  await expect(getPendingOpenedPullRequests(context, "user2")).resolves.toEqual([pullRequest]);
});

test("does not count no-review PRs before the review delay", async () => {
  const { context } = createContext({
    pullRequestCreatedAt: hoursAgo(2),
  });

  await expect(getPendingOpenedPullRequests(context, "user2")).resolves.toEqual([]);
});
