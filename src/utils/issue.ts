import { Context } from "../types/context";
import { GitHubIssueSearch, Review } from "../types/payload";
import { getLinkedPullRequests, GetLinkedResults } from "./get-linked-prs";

export function isParentIssue(body: string) {
  const parentPattern = /-\s+\[( |x)\]\s+#\d+/;
  return body.match(parentPattern);
}

export async function getAssignedIssues(context: Context, username: string): Promise<GitHubIssueSearch["items"]> {
  const payload = context.payload;

  try {
    return await context.octokit
      .paginate(context.octokit.search.issuesAndPullRequests, {
        q: `org:${payload.repository.owner.login} assignee:${username} is:open`,
        per_page: 100,
        order: "desc",
        sort: "created",
      })
      .then((issues) =>
        issues.filter((issue) => {
          return (
            issue.state === "open" &&
            !issue.pull_request &&
            (issue.assignee?.login === username || issue.assignees?.some((assignee) => assignee.login === username))
          );
        })
      );
  } catch (err: unknown) {
    context.logger.error("Fetching assigned issues failed!", { error: err as Error });
    return [];
  }
}

export async function addCommentToIssue(context: Context, message: string | null) {
  const comment = message as string;

  const { payload } = context;

  const issueNumber = payload.issue.number;
  try {
    await context.octokit.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNumber,
      body: comment,
    });
  } catch (err: unknown) {
    context.logger.error("Adding a comment failed!", { error: err as Error });
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
    context.logger.error("Closing pull requests failed!", { error: err as Error });
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
}

export async function getAllPullRequests(context: Context, state: "open" | "closed" | "all" = "open", username: string) {
  const { payload } = context;

  try {
    return (await context.octokit.paginate(context.octokit.search.issuesAndPullRequests, {
      q: `org:${payload.repository.owner.login} author:${username} state:${state}`,
      per_page: 100,
      order: "desc",
      sort: "created",
    })) as GitHubIssueSearch["items"];
  } catch (err: unknown) {
    context.logger.error("Fetching all pull requests failed!", { error: err as Error });
    return [];
  }
}

export async function getAllPullRequestReviews(context: Context, pullNumber: number, owner: string, repo: string) {
  try {
    return (await context.octokit.paginate(context.octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
    })) as Review[];
  } catch (err: unknown) {
    context.logger.error("Fetching all pull request reviews failed!", { error: err as Error });
    return [];
  }
}

export async function getAvailableOpenedPullRequests(context: Context, username: string) {
  const { reviewDelayTolerance } = context.config.timers;
  if (!reviewDelayTolerance) return [];

  const openedPullRequests = await getOpenedPullRequests(context, username);
  const result = [] as typeof openedPullRequests;

  for (let i = 0; i < openedPullRequests.length; i++) {
    const openedPullRequest = openedPullRequests[i];
    const owner = openedPullRequest.html_url.split("/")[3];
    const repo = openedPullRequest.html_url.split("/")[4];
    const reviews = await getAllPullRequestReviews(context, openedPullRequest.number, owner, repo);

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
  const prs = await getAllPullRequests(context, "open", username);
  return prs.filter((pr) => pr.pull_request && pr.state === "open");
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
