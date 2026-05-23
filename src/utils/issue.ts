import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import ms from "ms";
import { QUERY_PULL_REQUEST_REVIEW_THREADS } from "../github-queries";
import { Context } from "../types/context";
import { AssignedIssue, GitHubIssueSearch, PrState, Review } from "../types/payload";
import { AssignedIssueScope, Role } from "../types/plugin-input";
import { getOpenLinkedPullRequestsForIssue, GetLinkedResults } from "./get-linked-prs";
import { getAllPullRequestsFallback, getAssignedIssuesFallback } from "./get-pull-requests-fallback";

export function isParentIssue(body: string) {
  const parentPattern = /-\s+\[( |x)\]\s+#\d+/;
  return body.match(parentPattern);
}

export async function getAssignedIssues(context: Context, username: string): Promise<AssignedIssue[]> {
  let repoOrgQuery = "";
  if (context.config.assignedIssueScope === AssignedIssueScope.REPO) {
    repoOrgQuery = `repo:${context.payload.repository.full_name}`;
  } else {
    context.organizations.forEach((org) => {
      repoOrgQuery += `org:${org} `;
    });
  }

  try {
    const issues = await context.octokit.paginate(context.octokit.rest.search.issuesAndPullRequests, {
      q: `${repoOrgQuery} archived:false is:open is:issue assignee:${username}`,
      per_page: 100,
      order: "desc",
      sort: "created",
    });
    return issues.filter((issue) => {
      const repository = issue.repository;
      if (repository?.archived) return false;
      return (
        issue.assignee?.login?.toLowerCase() === username.toLowerCase() ||
        issue.assignees?.some((assignee) => assignee.login?.toLowerCase() === username.toLowerCase())
      );
    });
  } catch (err) {
    context.logger.debug("Will try re-fetching assigned issues...", { error: err as Error });
    return getAssignedIssuesFallback(context, username);
  }
}

// Pull Requests

export async function closePullRequest(context: Context, results: Pick<GetLinkedResults, "number">) {
  const { payload } = context;
  const params: RestEndpointMethodTypes["pulls"]["update"]["parameters"] = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pull_number: results.number,
    state: "closed",
  };
  context.logger.info("Closing linked pull-request.", {
    params,
  });
  try {
    await context.octokit.rest.pulls.update(params);
  } catch (err: unknown) {
    throw new Error(context.logger.error("Closing pull requests failed!", { error: err as Error }).logMessage.raw);
  }
}

export async function closePullRequestForAnIssue(context: Context, issueNumber: number, repository: Context["payload"]["repository"], author: string) {
  const { logger } = context;
  if (!issueNumber) {
    throw logger.error("Issue is not defined", {
      issueNumber,
      repository: repository.name,
    });
  }

  const linkedPullRequests = await getOpenLinkedPullRequestsForIssue(context, {
    owner: repository.owner.login,
    repository: repository.name,
    issue: issueNumber,
  });

  if (!linkedPullRequests.length) {
    return logger.debug(`No linked pull requests to close`);
  }

  logger.info(`Opened prs`, { author, linkedPullRequests });
  let comment = "```diff\n# These linked pull requests are closed: ";

  let isClosed = false;

  for (const pr of linkedPullRequests) {
    /**
     * If the PR author is not the same as the issue author, skip the PR
     * If the PR organization is not the same as the issue organization, skip the PR
     *
     * Same organization and author, close the PR
     */
    if (pr.author !== author || pr.organization !== repository.owner.login) {
      continue;
    }
    await closePullRequest(context, pr);
    comment += ` ${pr.href} `;
    isClosed = true;
  }

  if (!isClosed) {
    return logger.debug(`No PRs were closed`);
  }

  return logger.ok(comment);
}

async function confirmMultiAssignment(context: Context, issueNumber: number, usernames: string[]) {
  const { logger, payload, octokit } = context;

  if (usernames.length < 2) {
    return;
  }

  const { private: isPrivate } = payload.repository;

  const {
    data: { assignees },
  } = await octokit.rest.issues.get({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issueNumber,
  });

  if (!assignees?.length) {
    throw logger.error("We detected that this task was not assigned to anyone. Please report this to the maintainers.", { issueNumber, usernames });
  }

  if (isPrivate && assignees?.length <= 1) {
    const log = logger.warn("This task belongs to a private repo and can only be assigned to one user without an official paid GitHub subscription.", {
      issueNumber,
    });
    await context.commentHandler.postComment(context, log);
  }
}

export async function addAssignees(context: Context & { installOctokit: Context["octokit"] }, issueNo: number, assignees: string[]) {
  const repository = context.payload.repository;

  try {
    await context.installOctokit.rest.issues.addAssignees({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issueNo,
      assignees,
    });
  } catch (e: unknown) {
    throw context.logger.error("Adding the assignee failed", { assignee: assignees, issueNo, error: e as Error });
  }

  await confirmMultiAssignment(context, issueNo, assignees);
}

async function getAllPullRequests(context: Context, state = "open", username: string) {
  let repoOrgQuery = "";
  if (context.config.assignedIssueScope === AssignedIssueScope.REPO) {
    repoOrgQuery = `repo:${context.payload.repository.full_name}`;
  } else {
    context.organizations.forEach((org) => {
      repoOrgQuery += `org:${org} `;
    });
  }

  const query: RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["parameters"] = {
    q: `${repoOrgQuery} author:${username} state:${state} is:pr archived:false`,
    per_page: 100,
    order: "desc",
    sort: "created",
  };

  try {
    return (await context.octokit.paginate(context.octokit.rest.search.issuesAndPullRequests, query)) as GitHubIssueSearch["items"];
  } catch (err: unknown) {
    throw context.logger.error("Fetching all pull requests failed!", { error: err as Error, query });
  }
}

export async function getAllPullRequestsWithRetry(context: Context, state: PrState, username: string) {
  try {
    return await getAllPullRequests(context, state, username);
  } catch (error) {
    context.logger.debug("Will retry re-fetching all pull requests...", { error: error as Error });
    return getAllPullRequestsFallback(context, state, username);
  }
}

export async function getAllPullRequestReviews(context: Context, pullNumber: number, owner: string, repo: string) {
  const {
    config: { rolesWithReviewAuthority },
  } = context;
  try {
    return (
      await context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      })
    ).filter((review) => rolesWithReviewAuthority.includes(review.author_association as Role)) as Review[];
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && err.status === 404) {
      return [];
    } else {
      throw context.logger.error("Fetching all pull request reviews failed!", { error: err as Error });
    }
  }
}

export function getOwnerRepoFromHtmlUrl(url: string) {
  const parts = url.split("/");
  if (parts.length < 5) {
    throw new Error("Invalid URL");
  }
  return {
    owner: parts[3],
    repo: parts[4],
  };
}

async function getReviewByUser(context: Context, pullRequest: Awaited<ReturnType<typeof getOpenedPullRequestsForUser>>[0]) {
  const { owner, repo } = getOwnerRepoFromHtmlUrl(pullRequest.html_url);
  const reviews = (await getAllPullRequestReviews(context, pullRequest.number, owner, repo)).sort((a, b) => {
    if (!a?.submitted_at || !b?.submitted_at) {
      return 0;
    }
    return new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime();
  });
  const latestReviewsByUser: Map<number, Review> = new Map();
  for (const review of reviews) {
    const isReviewRequestedForUser =
      "requested_reviewers" in pullRequest && pullRequest.requested_reviewers && pullRequest.requested_reviewers.some((o) => o.id === review.user?.id);
    if (!isReviewRequestedForUser && review.user?.id && !latestReviewsByUser.has(review.user?.id)) {
      latestReviewsByUser.set(review.user?.id, review);
    }
  }

  return latestReviewsByUser;
}

interface ReviewThreadComment {
  author?: {
    login?: string;
  } | null;
  createdAt?: string | null;
}

interface ReviewThread {
  isResolved?: boolean | null;
  comments?: {
    nodes?: (ReviewThreadComment | null)[] | null;
  } | null;
}

function getLatestThreadComment(thread: ReviewThread): ReviewThreadComment | null {
  const comments = thread.comments?.nodes?.filter((comment): comment is ReviewThreadComment => !!comment?.createdAt) ?? [];

  return comments.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0] ?? null;
}

async function areUnresolvedReviewThreadsWaitingOnReviewer(
  context: Context,
  {
    owner,
    repo,
    pullNumber,
    username,
    reviewDelayTolerance,
  }: {
    owner: string;
    repo: string;
    pullNumber: number;
    username: string;
    reviewDelayTolerance: string;
  }
) {
  try {
    const response = await context.octokit.graphql.paginate<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes?: (ReviewThread | null)[] | null;
          } | null;
        } | null;
      } | null;
    }>(QUERY_PULL_REQUEST_REVIEW_THREADS, {
      owner,
      repo,
      pull_number: pullNumber,
    });
    const unresolvedThreads =
      response.repository?.pullRequest?.reviewThreads?.nodes?.filter((thread): thread is ReviewThread => !!thread && !thread.isResolved) ?? [];

    if (!unresolvedThreads.length) {
      return true;
    }

    const tolerance = getTimeValue(reviewDelayTolerance);
    const normalizedUsername = username.toLowerCase();

    return unresolvedThreads.every((thread) => {
      const latestComment = getLatestThreadComment(thread);
      const latestAuthor = latestComment?.author?.login?.toLowerCase();
      const latestAt = latestComment?.createdAt ? new Date(latestComment.createdAt).getTime() : 0;

      return latestAuthor === normalizedUsername && new Date().getTime() - latestAt >= tolerance;
    });
  } catch (err) {
    context.logger.debug("Unable to inspect pull request review threads for task limit bypass.", { error: err as Error, owner, repo, pullNumber });
    return false;
  }
}

async function shouldSkipPullRequest(
  context: Context,
  pullRequest: Awaited<ReturnType<typeof getOpenedPullRequestsForUser>>[0],
  reviews: Awaited<ReturnType<typeof getReviewByUser>>,
  { owner, repo, issueNumber }: { owner: string; repo: string; issueNumber: number },
  reviewDelayTolerance: string
) {
  const timeline = await context.octokit.paginate(context.octokit.rest.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: issueNumber,
  });
  const reviewEvent = timeline.filter((o) => o.event === "review_requested").pop();
  const referenceTime = reviewEvent && "created_at" in reviewEvent ? new Date(reviewEvent.created_at).getTime() : new Date(pullRequest.created_at).getTime();

  // If no reviews exist, check time reference
  if (reviews.size === 0) {
    return new Date().getTime() - referenceTime >= getTimeValue(reviewDelayTolerance);
  }

  // If changes are requested, only skip when all unresolved review threads are waiting on the PR author.
  if (Array.from(reviews.values()).some((review) => review.state === "CHANGES_REQUESTED")) {
    return areUnresolvedReviewThreadsWaitingOnReviewer(context, {
      owner,
      repo,
      pullNumber: pullRequest.number,
      username: pullRequest.user?.login ?? "",
      reviewDelayTolerance,
    });
  }

  // If no approvals exist or time reference has exceeded review delay tolerance
  const hasApproval = Array.from(reviews.values()).some((review) => review.state === "APPROVED");
  const isTimePassed = new Date().getTime() - referenceTime >= getTimeValue(reviewDelayTolerance);

  return hasApproval || !isTimePassed;
}

/**
 * Returns all the pull-requests pending approval, which count negatively against the PR author's quota.
 */
export async function getPendingOpenedPullRequests(context: Context, username: string) {
  const { reviewDelayTolerance } = context.config;
  if (!reviewDelayTolerance) return [];

  const openedPullRequests = await getOpenedPullRequestsForUser(context, username);
  const result: (typeof openedPullRequests)[number][] = [];

  for (let i = 0; openedPullRequests && i < openedPullRequests.length; i++) {
    const openedPullRequest = openedPullRequests[i];
    if (!openedPullRequest) continue;
    const { owner, repo } = getOwnerRepoFromHtmlUrl(openedPullRequest.html_url);
    const latestReviewsByUser = await getReviewByUser(context, openedPullRequest);
    const shouldSkipPr = await shouldSkipPullRequest(
      context,
      openedPullRequest,
      latestReviewsByUser,
      { owner, repo, issueNumber: openedPullRequest.number },
      reviewDelayTolerance
    );
    if (!shouldSkipPr) {
      result.push(openedPullRequest);
    }
  }

  return result;
}

export function getTimeValue(timeString: string): number {
  const timeValue = ms(timeString);

  if (!timeValue || timeValue <= 0 || isNaN(timeValue)) {
    throw new Error("Invalid config time value");
  }

  return timeValue;
}

async function getOpenedPullRequestsForUser(context: Context, username: string): Promise<ReturnType<typeof getAllPullRequestsWithRetry>> {
  return getAllPullRequestsWithRetry(context, "open", username);
}
