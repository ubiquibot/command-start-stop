import { Context } from "../../types";
import { getAppId } from "../../utils/shared";

export async function hasUserBeenUnassigned(context: Context): Promise<boolean> {
  const APP_ID = getAppId(context);
  const events = await getAssignmentEvents(context);
  const senderLogin = context.payload.comment.user?.login.toLowerCase() || context.payload.sender.login.toLowerCase();
  const userAssignments = events.filter((event) => event.assignee?.toLowerCase() === senderLogin);

  if (userAssignments.length === 0) {
    return false;
  }

  const unassignedEvents = userAssignments.filter((event) => event.event === "unassigned");
  const botUnassigned = unassignedEvents.filter((event) => event.actorId === APP_ID);
  const adminUnassigned = unassignedEvents.filter((event) => event.actor?.toLowerCase() !== senderLogin && event.actorId !== APP_ID);
  return botUnassigned.length > 0 || adminUnassigned.length > 0;
}

async function getAssignmentEvents(context: Context) {
  const { repository, issue } = context.payload;
  try {
    const data = await context.octokit.paginate(context.octokit.issues.listEventsForTimeline, {
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issue.number,
    });

    const events = data
      .filter((event) => event.event === "assigned" || event.event === "unassigned")
      .map((event) => {
        let actor, assignee, createdAt, actorId;

        if ((event.event === "unassigned" || event.event === "assigned") && "actor" in event && event.actor && "assignee" in event && event.assignee) {
          actor = event.actor.login;
          assignee = event.assignee.login;
          createdAt = event.created_at;
          actorId = event.actor.id;
        }

        return {
          event: event.event,
          actor,
          actorId,
          assignee,
          createdAt,
        };
      });

    return events
      .filter((event) => event !== undefined)
      .sort((a, b) => {
        return new Date(a.createdAt || "").getTime() - new Date(b.createdAt || "").getTime();
      });
  } catch (error) {
    throw context.logger.error("Error while getting assignment events", { error: error as Error });
  }
}
