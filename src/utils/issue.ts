import { Context } from "../types/context";
import { Issue, PullRequest, Review } from "../types/payload";
import { getLinkedPullRequests, GetLinkedResults } from "./get-linked-prs";

export function isParentIssue(body: string) {
  const parentPattern = /-\s+\[( |x)\]\s+#\d+/;
  return body.match(parentPattern);
}

export async function getAssignedIssues(context: Context, username: string): Promise<Issue[]> {
  const { payload } = context;

  try {
    return (await context.octokit.paginate(context.octokit.rest.search.issuesAndPullRequests, {
      q: `is:issue is:open assignee:${username} org:${payload.repository.owner.login}`,
    })) as Issue[];
  } catch (err: unknown) {
    throw context.logger.error("Fetching assigned issues failed!", { error: err as Error });
  }
}

export async function addCommentToIssue(context: Context, message: string | null) {
  const comment = message as string;

  const { payload } = context;

  const issueNumber = payload.issue.number;
  try {
    await context.octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNumber,
      body: comment,
    });
  } catch (err: unknown) {
    throw context.logger.error("Adding a comment failed!", { error: err as Error });
  }
}

// Pull Requests

export async function closePullRequest(context: Context, results: GetLinkedResults) {
  const { payload } = context;
  try {
    await context.octokit.rest.pulls.update({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: results.number,
      state: "closed",
    });
  } catch (err: unknown) {
    throw context.logger.error("Closing pull requests failed!", { error: err as Error });
  }
}

export async function closePullRequestForAnIssue(context: Context, issueNumber: number, repository: Context["payload"]["repository"], author: string) {
  const { logger } = context;
  if (!issueNumber) {
    logger.error("Issue is not defined");
    return;
  }

  const linkedPullRequests = await getLinkedPullRequests(context, {
    owner: repository.owner.login,
    repository: repository.name,
    issue: issueNumber,
  });

  if (!linkedPullRequests.length) {
    return logger.info(`No linked pull requests to close`);
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
    } else {
      const isLinked = issueLinkedViaPrBody(pr.body, issueNumber);
      if (!isLinked) {
        logger.info(`Issue is not linked to the PR`, { issueNumber, prNumber: pr.number });
        continue;
      }
      await closePullRequest(context, pr);
      comment += ` ${pr.href} `;
      isClosed = true;
    }
  }

  if (!isClosed) {
    return logger.info(`No PRs were closed`);
  }

  await addCommentToIssue(context, comment);
  return logger.info(comment);
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
    const log = logger.error("We detected that this task was not assigned to anyone. Please report this to the maintainers.", { issueNumber, usernames });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error(log?.logMessage.raw);
  }

  if (isPrivate && assignees?.length <= 1) {
    const log = logger.error("This task belongs to a private repo and can only be assigned to one user without an official paid GitHub subscription.", {
      issueNumber,
    });
    await addCommentToIssue(context, log?.logMessage.diff as string);
  }
}

export async function addAssignees(context: Context, issueNo: number, assignees: string[]) {
  const payload = context.payload;

  try {
    await context.octokit.rest.issues.addAssignees({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNo,
      assignees,
    });
  } catch (e: unknown) {
    throw context.logger.error("Adding the assignee failed", { assignee: assignees, issueNo, error: e as Error });
  }

  await confirmMultiAssignment(context, issueNo, assignees);
}

export async function getAllPullRequests(context: Context, state: "open" | "closed" | "all" = "open") {
  const payload = context.payload;

  try {
    return (await context.octokit.paginate(context.octokit.rest.pulls.list, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      state,
      per_page: 100,
    })) as PullRequest[];
  } catch (err: unknown) {
    throw context.logger.error("Fetching all pull requests failed!", { error: err as Error });
  }
}

export async function getAllPullRequestReviews(context: Context, pullNumber: number, format: "raw" | "html" | "text" | "full" = "raw") {
  const payload = context.payload;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  try {
    return (await context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      mediaType: {
        format,
      },
    })) as Review[];
  } catch (err: unknown) {
    throw context.logger.error("Fetching all pull request reviews failed!", { error: err as Error });
  }
}

export async function getAvailableOpenedPullRequests(context: Context, username: string) {
  const { reviewDelayTolerance } = context.config.timers;
  if (!reviewDelayTolerance) return [];

  const openedPullRequests = await getOpenedPullRequests(context, username);
  const result = [] as typeof openedPullRequests;

  for (let i = 0; i < openedPullRequests.length; i++) {
    const openedPullRequest = openedPullRequests[i];
    const reviews = await getAllPullRequestReviews(context, openedPullRequest.number);

    if (reviews.length > 0) {
      const approvedReviews = reviews.find((review) => review.state === "APPROVED");
      if (approvedReviews) {
        result.push(openedPullRequest);
      }
    }

    if (reviews.length === 0 && (new Date().getTime() - new Date(openedPullRequest.created_at).getTime()) / (1000 * 60 * 60) >= reviewDelayTolerance) {
      result.push(openedPullRequest);
    }
  }
  return result;
}

async function getOpenedPullRequests(context: Context, username: string): Promise<ReturnType<typeof getAllPullRequests>> {
  const prs = await getAllPullRequests(context, "open");
  return prs.filter((pr) => !pr.draft && (pr.user?.login === username || !username));
}

/**
 * Extracts the task id from the PR body. The format is:
 * `Resolves #123`
 * `Fixes https://github.com/.../issues/123`
 * `Closes #123`
 * `Depends on #123`
 * `Related to #123`
 */
export function issueLinkedViaPrBody(prBody: string | null, issueNumber: number): boolean {
  if (!prBody) {
    return false;
  }
  const regex = // eslint-disable-next-line no-useless-escape
    /(?:Resolves|Fixes|Closes|Depends on|Related to) #(\d+)|https:\/\/(?:www\.)?github.com\/([^\/]+)\/([^\/]+)\/(issue|issues)\/(\d+)|#(\d+)/gi;

  const containsHtmlComment = /<!-*[\s\S]*?-*>/g;
  prBody = prBody?.replace(containsHtmlComment, ""); // Remove HTML comments

  const matches = prBody?.match(regex);

  if (!matches) {
    return false;
  }

  let issueId;

  matches.map((match) => {
    if (match.startsWith("http")) {
      // Extract the issue number from the URL
      const urlParts = match.split("/");
      issueId = urlParts[urlParts.length - 1];
    } else {
      // Extract the issue number directly from the hashtag
      const hashtagParts = match.split("#");
      issueId = hashtagParts[hashtagParts.length - 1]; // The issue number follows the '#'
    }
  });

  return issueId === issueNumber.toString();
}
