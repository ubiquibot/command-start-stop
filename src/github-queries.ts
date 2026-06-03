export const QUERY_OPEN_LINKED_PULL_REQUESTS_FOR_ISSUE = /* GraphQL */ `
  query openLinkedPullRequestsForIssue($owner: String!, $repo: String!, $issue_number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issue_number) {
        closedByPullRequestsReferences(first: 100, after: $cursor, includeClosedPrs: false) {
          nodes {
            number
            url
            author {
              login
            }
            repository {
              name
              owner {
                login
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

export const QUERY_PULL_REQUEST_REVIEW_THREADS = /* GraphQL */ `
  query pullRequestReviewThreads($owner: String!, $repo: String!, $pull_number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pull_number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            isResolved
            comments(last: 1) {
              nodes {
                author {
                  login
                }
                createdAt
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;
