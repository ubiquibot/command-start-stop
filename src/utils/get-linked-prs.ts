import { Issue, TimelineEventResponse, TimelineEvents } from "../types";
import { Context } from "../types/context";

interface GetLinkedParams {
  owner: string;
  repository: string;
  issue?: number;
  pull?: number;
}

export interface GetLinkedResults {
  organization: string;
  repository: string;
  number: number;
  href: string;
  author: string;
  body: string | null;
}

export async function getLinkedPullRequests(context: Context, { owner, repository, issue }: GetLinkedParams): Promise<GetLinkedResults[]> {
  if (!issue) {
    throw new Error("Issue is not defined");
  }

  const { data: timeline } = (await context.octokit.rest.issues.listEventsForTimeline({
    owner,
    repo: repository,
    issue_number: issue,
  })) as TimelineEventResponse;

  const LINKED_PRS = timeline
    .filter((event: TimelineEvents) => event.event === "cross-referenced" && "source" in event && !!event.source.issue && "pull_request" in event.source.issue)
    .map((event: TimelineEvents) => (event as { source: { issue: Issue } }).source.issue) as Issue[];

  return LINKED_PRS.map((pr) => {
    return {
      organization: pr.repository?.full_name.split("/")[0] as string,
      repository: pr.repository?.full_name.split("/")[1] as string,
      number: pr.number,
      href: pr.html_url,
      author: pr.user?.login,
      state: pr.state,
      body: pr.body,
    };
  }).filter((pr) => pr !== null && pr.state === "open") as GetLinkedResults[];
}
