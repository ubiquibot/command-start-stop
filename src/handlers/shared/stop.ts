import { Assignee, Context } from "../../types";
import { addCommentToIssue, closePullRequestForAnIssue } from "../../utils/issue";

export async function stop(context: Context, issue: Context["payload"]["issue"], sender: Context["payload"]["sender"], repo: Context["payload"]["repository"]) {
  const { logger } = context;
  const issueNumber = issue.number;

  // is there an assignee?
  const assignees = issue.assignees ?? [];
  // should unassign?
  const userToUnassign = assignees.find((assignee: Partial<Assignee>) => assignee?.login?.toLowerCase() === sender.login.toLowerCase());

  if (!userToUnassign) {
    const log = logger.error("You are not assigned to this task", { issueNumber, user: sender.login });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    return { output: "You are not assigned to this task" };
  }

  // close PR
  await closePullRequestForAnIssue(context, issueNumber, repo, userToUnassign.login);

  const {
    name,
    owner: { login },
  } = repo;

  // remove assignee

  try {
    await context.octokit.rest.issues.removeAssignees({
      owner: login,
      repo: name,
      issue_number: issueNumber,
      assignees: [userToUnassign.login],
    });
  } catch (err) {
    throw new Error(`Error while removing ${userToUnassign.login} from the issue: ${err}`);
  }

  const unassignedLog = logger.info("You have been unassigned from the task", {
    issueNumber,
    user: userToUnassign.login,
  });

  await addCommentToIssue(context, unassignedLog?.logMessage.diff as string);
  return { output: "Task unassigned successfully" };
}
