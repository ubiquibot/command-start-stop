import { StaticDecode, Type as T } from "@sinclair/typebox";

export enum AssignedIssueScope {
  ORG = "org",
  REPO = "repo",
  NETWORK = "network",
}

export enum Role {
  OWNER = "OWNER",
  ADMIN = "ADMIN",
  MEMBER = "MEMBER",
  COLLABORATOR = "COLLABORATOR",
}

// These correspond to getMembershipForUser and getCollaboratorPermissionLevel for a user.
// Anything outside these values is considered to be a contributor (external user).
export const ADMIN_ROLES = ["admin", "owner", "billing_manager"];
export const COLLABORATOR_ROLES = ["write", "member", "collaborator"];

const rolesWithReviewAuthority = T.Array(T.Enum(Role), {
  default: [Role.OWNER, Role.ADMIN, Role.MEMBER, Role.COLLABORATOR],
  uniqueItems: true,
  description: "When considering a user for a task: which roles should be considered as having review authority? All others are ignored.",
  examples: [
    [Role.OWNER, Role.ADMIN],
    [Role.MEMBER, Role.COLLABORATOR],
  ],
});

const maxConcurrentTasks = T.Object(
  {
    collaborator: T.Number({ default: 10 }),
    contributor: T.Number({ default: 2 }),
  },
  {
    description: "The maximum number of tasks a user can have assigned to them at once, based on their role.",
    examples: [{ collaborator: 10, contributor: 2 }],
    default: {},
  }
);

const roles = T.KeyOf(maxConcurrentTasks);

const PRIORITY_EMERGENCY_LABEL = "Priority: 5 (Emergency)";

const requiredLabel = T.Object({
  name: T.String({ description: "The name of the required labels to start the task." }),
  allowedRoles: T.Array(roles, {
    description: "The list of allowed roles to start the task with the given label.",
    uniqueItems: true,
    default: [],
    examples: [["collaborator", "contributor"]],
  }),
});

const accountRequiredAge = T.Object(
  {
    minimumDays: T.Number({
      default: 365.25,
      minimum: 0,
      description: "Minimum number of days a GitHub account must exist before starting a task.",
      examples: [0, 30, 365.25],
    }),
  },
  {
    default: { minimumDays: 365.25 },
  }
);

export const DEFAULT_EXPERIENCE_PRIORITY_THRESHOLDS = [
  { label: "Priority: 0 (Regression)", minimumXp: -2000 },
  { label: "Priority: 1 (Normal)", minimumXp: -1000 },
  { label: "Priority: 2 (Medium)", minimumXp: 0 },
  { label: "Priority: 3 (High)", minimumXp: 1000 },
  { label: "Priority: 4 (Urgent)", minimumXp: 2000 },
  { label: PRIORITY_EMERGENCY_LABEL, minimumXp: 3000 },
] as const;

const experiencePriorityThreshold = T.Object({
  label: T.String({
    description: "Issue label to match for experience gating.",
    examples: ["Priority: 1 (Normal)", "prio 1"],
  }),
  minimumXp: T.Number({
    default: 0,
    description: "Minimum XP required to start a task with the associated label.",
    examples: [-2000, 0, 3000],
  }),
});

const experienceAccessControl = T.Object(
  {
    priorityThresholds: T.Array(experiencePriorityThreshold, {
      default: DEFAULT_EXPERIENCE_PRIORITY_THRESHOLDS,
      description: "Mappings between priority labels and minimum XP required to start tasks with those labels.",
      examples: [
        [
          { label: "Priority: 0", minimumXp: -2000 },
          { label: PRIORITY_EMERGENCY_LABEL, minimumXp: 3000 },
        ],
      ],
    }),
  },
  {
    default: { priorityThresholds: DEFAULT_EXPERIENCE_PRIORITY_THRESHOLDS },
  }
);

const transformedRole = T.Transform(T.Union([T.Number(), T.Literal("Infinity")], { default: "Infinity" }))
  .Decode((value) => {
    if (typeof value === "number") {
      return value;
    }

    if (!isNaN(parseFloat(value))) {
      return parseFloat(value);
    } else {
      return Infinity;
    }
  })
  .Encode((value) => value);

export const pluginSettingsSchema = T.Object(
  {
    reviewDelayTolerance: T.String({
      default: "1 Day",
      examples: ["1 Day", "5 Days"],
      description:
        "When considering a user for a task: if they have existing PRs with no reviews, how long should we wait before 'increasing' their assignable task limit?",
    }),
    reviewerLagTimeout: T.String({
      default: "24 Hours",
      examples: ["12 Hours", "24 Hours", "48 Hours"],
      description:
        "When considering a user for a task: if they have existing PRs where they are the last commenter on all unresolved review threads, how long should we wait before considering those PRs as 'reviewer-lagged' and not counting them against the task limit?",
    }),
    taskStaleTimeoutDuration: T.String({
      default: "30 Days",
      examples: ["1 Day", "5 Days"],
      description: "When displaying the '/start' response, how long should we wait before considering a task 'stale' and provide a warning?",
    }),
    startRequiresWallet: T.Boolean({
      default: true,
      description: "If true, users must set their wallet address with the /wallet command before they can start tasks.",
    }),
    maxConcurrentTasks: maxConcurrentTasks,
    assignedIssueScope: T.Enum(AssignedIssueScope, {
      default: AssignedIssueScope.ORG,
      description: "When considering a user for a task: should we consider their assigned issues at the org, repo, or network level?",
      examples: [AssignedIssueScope.ORG, AssignedIssueScope.REPO, AssignedIssueScope.NETWORK],
    }),
    emptyWalletText: T.String({
      default: "Please set your wallet address with the /wallet command first and try again.",
      description: "a message to display when a user tries to start a task without setting their wallet address.",
    }),
    rolesWithReviewAuthority: T.Transform(rolesWithReviewAuthority)
      .Decode((value) => value.map((role) => role.toUpperCase()))
      .Encode((value) => value.map((role) => Role[role as keyof typeof Role])),
    requiredLabelsToStart: T.Array(requiredLabel, {
      default: [],
      description: "If set, a task must have at least one of these labels to be started.",
      examples: [[PRIORITY_EMERGENCY_LABEL], ["Good First Issue"]],
    }),
    taskAccessControl: T.Object(
      {
        usdPriceMax: T.Object(
          {
            collaborator: transformedRole,
            contributor: transformedRole,
          },
          {
            default: {},
            description:
              "The maximum USD price a user can start a task with, based on their role. Set to a negative value to indicate only core operations (only collaborators) can be started.",
            examples: [
              { collaborator: "Infinity", contributor: 0 },
              { collaborator: "Infinity", contributor: -1 },
            ],
          }
        ),
        accountRequiredAge: T.Optional(accountRequiredAge),
        experience: T.Optional(experienceAccessControl),
      },
      { default: {} }
    ),
  },
  {
    default: {},
  }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
