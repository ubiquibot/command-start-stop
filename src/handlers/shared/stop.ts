import { Context } from "../../types";
import { addCommentToIssue, closePullRequestForAnIssue } from "../../utils/issue";

export async function stop(context: Context, issue: Context["payload"]["issue"], sender: Context["payload"]["sender"], repo: Context["payload"]["repository"]) {
  const { logger } = context;
  const issueNumber = issue.number;
  const out = { output: null };

  // is it an issue?
  if (!issue) {
    logger.info(`Skipping '/stop' because of no issue instance`);
    return out;
  }

  // is there an assignee?
  const assignees = issue.assignees ?? [];
  if (assignees.length == 0) {
    logger.error("No assignees found for issue", { issueNumber });
    await addCommentToIssue(context, "````diff\n! You are not assigned to this task.\n````");
    return { output: "No assignees found for this task" }
  }

  // should unassign?
  const shouldUnassign = assignees[0]?.login.toLowerCase() == sender.login.toLowerCase();

  if (!shouldUnassign) {
    logger.error("You are not assigned to this task", { issueNumber, user: sender.login });
    return { output: "You are not assigned to this task" };
  }

  // close PR

  await closePullRequestForAnIssue(context, issueNumber, repo);

  const {
    name,
    owner: { login },
  } = repo;

  // remove assignee

  await context.octokit.rest.issues.removeAssignees({
    owner: login,
    repo: name,
    issue_number: issueNumber,
    assignees: [sender.login],
  });

  logger.info("You have been unassigned from the task", {
    issueNumber,
    user: sender.login,
  });

  addCommentToIssue(context, "````diff\n+ You have been unassigned from this task.\n````").catch(logger.error);
  return { output: "Task unassigned successfully" };
}
