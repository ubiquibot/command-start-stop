import { Assignee, Context, ISSUE_TYPE, Label, Sender } from "../../types";
import { isParentIssue, getAvailableOpenedPullRequests, getAssignedIssues, addAssignees, addCommentToIssue } from "../../utils/issue";
import { calculateDurations } from "../../utils/shared";
import { checkTaskStale } from "./check-task-stale";
import { hasUserBeenUnassigned } from "./check-assignments";
import { generateAssignmentComment } from "./generate-assignment-comment";
import structuredMetadata from "./structured-metadata";
import { assignTableComment } from "./table";

export async function start(context: Context, issue: Context["payload"]["issue"], sender: Sender) {
  const { logger, config } = context;
  const { maxConcurrentTasks } = config.miscellaneous;
  const { taskStaleTimeoutDuration } = config.timers;

  // is it a child issue?
  if (issue.body && isParentIssue(issue.body)) {
    await addCommentToIssue(
      context,
      "```diff\n# Please select a child issue from the specification checklist to work on. The '/start' command is disabled on parent issues.\n```"
    );
    logger.error(`Skipping '/start' since the issue is a parent issue`);
    throw new Error("Issue is a parent issue");
  }

  const hasBeenPreviouslyUnassigned = await hasUserBeenUnassigned(context);

  if (hasBeenPreviouslyUnassigned) {
    const log = logger.error("You were previously unassigned from this task. You cannot reassign yourself.", { sender });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error("User was previously unassigned from this task");
  }

  let commitHash: string | null = null;

  try {
    const hashResponse = await context.octokit.repos.getCommit({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      ref: context.payload.repository.default_branch,
    });
    commitHash = hashResponse.data.sha;
  } catch (e) {
    logger.error("Error while getting commit hash", { error: e as Error });
  }

  // check max assigned issues

  const openedPullRequests = await getAvailableOpenedPullRequests(context, sender.login);
  logger.info(`Opened Pull Requests with approved reviews or with no reviews but over 24 hours have passed: `, {
    openedPullRequests: openedPullRequests.map((p) => p.html_url),
  });

  const assignedIssues = await getAssignedIssues(context, sender.login);
  logger.info("Max issue allowed is", { maxConcurrentTasks, assignedIssues: assignedIssues.map((i) => i.html_url) });

  // check for max and enforce max

  if (Math.abs(assignedIssues.length - openedPullRequests.length) >= maxConcurrentTasks) {
    const log = logger.error("Too many assigned issues, you have reached your max limit", {
      assignedIssues: assignedIssues.length,
      openedPullRequests: openedPullRequests.length,
      maxConcurrentTasks,
    });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error(`Too many assigned issues, you have reached your max limit of ${maxConcurrentTasks} issues.`);
  }

  // is it assignable?

  if (issue.state === ISSUE_TYPE.CLOSED) {
    const log = logger.error("This issue is closed, please choose another.", { issueNumber: issue.number });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error("Issue is closed");
  }

  const assignees = (issue?.assignees ?? []).filter(Boolean);
  if (assignees.length !== 0) {
    const log = logger.error("The issue is already assigned. Please choose another unassigned task.", { issueNumber: issue.number });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error("Issue is already assigned");
  }

  // get labels

  const labels = issue.labels;
  const priceLabel = labels.find((label: Label) => label.name.startsWith("Price: "));

  if (!priceLabel) {
    const log = logger.error("No price label is set to calculate the duration", { issueNumber: issue.number });
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error("No price label is set to calculate the duration");
  }

  const duration: number = calculateDurations(labels).shift() ?? 0;

  const assignmentComment = await generateAssignmentComment(context, issue.created_at, issue.number, sender.id, duration);
  const logMessage = logger.info("Task assigned successfully", {
    taskDeadline: assignmentComment.deadline,
    taskAssignees: [...assignees.map((a) => a?.login), sender.id],
    priceLabel,
    revision: commitHash?.substring(0, 7),
  });
  const metadata = structuredMetadata.create("Assignment", logMessage);

  // add assignee
  if (!assignees.map((i: Partial<Assignee>) => i?.login).includes(sender.login)) {
    await addAssignees(context, issue.number, [sender.login]);
  }

  const isTaskStale = checkTaskStale(taskStaleTimeoutDuration, issue.created_at);

  await addCommentToIssue(
    context,
    [
      assignTableComment({
        isTaskStale,
        daysElapsedSinceTaskCreation: assignmentComment.daysElapsedSinceTaskCreation,
        taskDeadline: assignmentComment.deadline,
        registeredWallet: assignmentComment.registeredWallet,
      }),
      assignmentComment.tips,
      metadata,
    ].join("\n") as string
  );

  return { output: "Task assigned successfully" };
}
