import ms from "ms";
import { Context } from "../types/context";
import { getOwnerRepoFromHtmlUrl } from "./issue";

interface ReviewThreadComment {
  id: string;
  body: string;
  author: { login: string } | null;
  createdAt: string;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: ReviewThreadComment[];
  };
}

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ReviewThreadNode[];
      };
    };
  } | null;
}

const QUERY_REVIEW_THREADS_FOR_PULL_REQUEST = /* GraphQL */ `
  query reviewThreadsForPullRequest($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                id
                body
                author {
                  login
                }
                createdAt
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetches all review threads for a pull request using the GitHub GraphQL API.
 */
async function getReviewThreadsForPullRequest(
  context: Context,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ReviewThreadNode[]> {
  try {
    const response = await context.octokit.graphql.paginate<ReviewThreadsResponse>(
      QUERY_REVIEW_THREADS_FOR_PULL_REQUEST,
      {
        owner,
        repo,
        number: pullNumber,
      }
    );

    const threads = response.repository?.pullRequest?.reviewThreads?.nodes;

    if (!threads) {
      return [];
    }

    return threads.filter((thread): thread is ReviewThreadNode => thread != null);
  } catch (err) {
    context.logger.debug("Failed to fetch review threads for pull request, skipping review thread check.", {
      owner,
      repo,
      pullNumber,
      error: err as Error,
    });
    return [];
  }
}

/**
 * Checks whether a user is the last commenter on all unresolved review threads
 * for a given pull request, and whether the reviewer lag timeout has elapsed
 * since their last comment.
 *
 * A pull request is considered "reviewer-lagged" when:
 * 1. The user is the last commenter on all unresolved review threads, AND
 * 2. The time elapsed since the user's most recent comment on those threads
 *    exceeds the reviewerLagTimeout duration.
 *
 * If there are no unresolved review threads, the PR is not reviewer-lagged
 * (the user has no pending review threads to respond to).
 */
export async function isReviewerLagged(
  context: Context,
  username: string,
  pullRequestHtmlUrl: string,
  pullNumber: number,
  reviewerLagTimeout: string
): Promise<boolean> {
  const { owner, repo } = getOwnerRepoFromHtmlUrl(pullRequestHtmlUrl);

  const reviewThreads = await getReviewThreadsForPullRequest(context, owner, repo, pullNumber);

  // If there are no review threads at all, the PR is not reviewer-lagged
  if (reviewThreads.length === 0) {
    return false;
  }

  // Filter to unresolved threads only — resolved threads don't need action
  const unresolvedThreads = reviewThreads.filter((thread) => !thread.isResolved);

  // If all threads are resolved, the PR is not reviewer-lagged
  if (unresolvedThreads.length === 0) {
    return false;
  }

  const timeoutMs = ms(reviewerLagTimeout);
  if (!timeoutMs || timeoutMs <= 0 || isNaN(timeoutMs)) {
    context.logger.debug("Invalid reviewerLagTimeout value, skipping reviewer lag check.", { reviewerLagTimeout });
    return false;
  }

  const now = Date.now();
  let mostRecentCommentTime = 0;

  // Check that the user is the last commenter on ALL unresolved review threads
  for (const thread of unresolvedThreads) {
    const comments = thread.comments?.nodes;
    if (!comments || comments.length === 0) {
      // No comments in the thread; can't determine last commenter — not reviewer-lagged
      return false;
    }

    // Find the last comment by timestamp
    const sortedComments = [...comments].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const lastComment = sortedComments[sortedComments.length - 1];

    // Check that the last commenter is the assignee (case-insensitive comparison)
    if (!lastComment.author || lastComment.author.login.toLowerCase() !== username.toLowerCase()) {
      // Someone else was the last commenter, meaning the reviewer has responded after the assignee.
      // The assignee is NOT the last commenter on this thread, so they may still need to act.
      return false;
    }

    const commentTime = new Date(lastComment.createdAt).getTime();
    if (commentTime > mostRecentCommentTime) {
      mostRecentCommentTime = commentTime;
    }
  }

  // The user is the last commenter on all unresolved threads.
  // Now check if the timeout has elapsed since their most recent comment.
  const timeSinceLastComment = now - mostRecentCommentTime;
  return timeSinceLastComment >= timeoutMs;
}
