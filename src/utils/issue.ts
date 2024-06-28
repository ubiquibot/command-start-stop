import { Context } from "../types/context";
import { Issue, ISSUE_TYPE } from "../types/payload";
import { getLinkedPullRequests } from "./get-linked-prs";

export function isParentIssue(body: string) {
  const parentPattern = /-\s+\[( |x)\]\s+#\d+/;
  return body.match(parentPattern);
}

export async function getAssignedIssues(context: Context, username: string): Promise<Issue[]> {
  const payload = context.payload;

  try {
    return await context.octokit.paginate(
      context.octokit.issues.listForRepo,
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        state: ISSUE_TYPE.OPEN,
        per_page: 1000,
      },
      ({ data: issues }) => issues.filter((issue) => !issue.pull_request && issue.assignee && issue.assignee.login === username)
    );
  } catch (err: unknown) {
    context.logger.fatal("Fetching assigned issues failed!", err);
    return [];
  }
}

export async function addCommentToIssue(context: Context, message: string | null) {
  let comment = message as string;

  const { payload } = context;

  const issueNumber = payload.issue.number;
  try {
    await context.octokit.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNumber,
      body: comment,
    });
  } catch (e: unknown) {
    context.logger.fatal("Adding a comment failed!", e);
  }
}

//// Pull Requests \\\\

export async function closePullRequest(context: Context, pullNumber: number) {
  const { repository } = context.payload;
  try {
    await context.octokit.rest.pulls.update({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pullNumber,
      state: "closed",
    });
  } catch (err: unknown) {
    context.logger.fatal("Closing pull requests failed!", err);
  }
}

export async function closePullRequestForAnIssue(context: Context, issueNumber: number, repository: Context["payload"]["repository"], author: string) {
  const logger = context.logger;
  if (!issueNumber) {
    throw logger.fatal("Issue is not defined");
  }

  const linkedPullRequests = await getLinkedPullRequests(context, {
    owner: repository.owner.login,
    repository: repository.name,
    issue: issueNumber,
  });

  if (!linkedPullRequests.length) {
    return logger.info(`No linked pull requests to close`);
  }

  logger.info(`Opened prs`, linkedPullRequests);
  let comment = `These linked pull requests are closed: `;

  const usersPR = linkedPullRequests.map((pr) => pr.author === author);

  if (usersPR.length === 0) {
    return logger.info(`No PRs to close`);
  }

  for (let i = 0; i < linkedPullRequests.length; i++) {
    if (usersPR[i]) {
      await closePullRequest(context, linkedPullRequests[i].number);
      comment += ` <a href="${linkedPullRequests[i].href}">#${linkedPullRequests[i].number}</a> `;
    }
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
    throw context.logger.fatal("Adding the assignee failed", { assignee: assignees, issueNo, error: e });
  }
}

export async function getAllPullRequests(context: Context, state: "open" | "closed" | "all" = "open") {
  const payload = context.payload;

  try {
    return await context.octokit.paginate(context.octokit.rest.pulls.list, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      state,
      per_page: 100,
    });
  } catch (err: unknown) {
    context.logger.fatal("Fetching all pull requests failed!", err);
    return [];
  }
}

export async function getAllPullRequestReviews(context: Context, pullNumber: number, format: "raw" | "html" | "text" | "full" = "raw") {
  const payload = context.payload;

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  try {
    return await context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      mediaType: {
        format,
      },
    });
  } catch (err: unknown) {
    context.logger.error("Fetching all pull request reviews failed!", err);
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
