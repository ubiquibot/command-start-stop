import { Context } from "../types";
import { addCommentToIssue } from "../utils/issue";
import { handleExperienceChecks } from "./experience-gate/xp-gate";
import { start } from "./shared/start";
import { stop } from "./shared/stop";

export async function userStartStop(context: Context): Promise<{ output: string | null }> {
  const { payload, config } = context;
  const { issue, comment, sender, repository } = payload;
  const slashCommand = comment.body.split(" ")[0].replace("/", "");
  const { isEnabled } = config;

  if (!isEnabled) {
    const log = context.logger.error(`The '/${slashCommand}' command is disabled for this repository`);
    await addCommentToIssue(context, log?.logMessage.diff as string);
    throw new Error(`The '/${slashCommand}' command is disabled for this repository.`);
  }

  if (slashCommand === "stop") {
    return await stop(context, issue, sender, repository);
  } else if (slashCommand === "start") {
    if (await handleExperienceChecks(context)) {
      return await start(context, issue, sender);
    } else {
      const log = context.logger.error(`You do not meet the requirements to start this task.`);
      await addCommentToIssue(context, log?.logMessage.diff as string);
    }
  }

  return { output: null };
}
