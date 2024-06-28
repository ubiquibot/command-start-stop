import { Issue } from "../types";
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
}

export async function getLinkedPullRequests(context: Context, { owner, repository, issue }: GetLinkedParams): Promise<GetLinkedResults[]> {
  if (!issue) {
    throw new Error("Issue is not defined");
  }

  const { data: timeline } = await context.octokit.issues.listEventsForTimeline({
    owner,
    repo: repository,
    issue_number: issue,
  });

  const LINKED_PRS = timeline
    .filter((event) => event.event === "cross-referenced" && "source" in event && !!event.source.issue && "pull_request" in event.source.issue)
    .map((event) => (event as { source: { issue: Issue } }).source.issue);

  return LINKED_PRS.map((pr) => {
    return {
      organization: pr.repository?.full_name.split("/")[0] as string,
      repository: pr.repository?.full_name.split("/")[1] as string,
      number: pr.number,
      href: pr.html_url,
      author: pr.user?.login,
    };
  }).filter((pr) => pr !== null) as GetLinkedResults[];
}
