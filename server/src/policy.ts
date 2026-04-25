import fs from "fs";
import path from "path";
import { loadConfig, resolveHubPath } from "./config";
import type { PolicyConfig } from "./config";

export class PolicyError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "PolicyError";
  }
}

function matches(allowlist: string[], value: string): boolean {
  if (allowlist.includes("*")) return true;
  return allowlist.includes(value);
}

export function assertAllowed(o: {
  repoId: string;
  workflow: string;
  channel?: string;
  slackUser?: string;
}): void {
  const config = loadConfig();
  const policy: PolicyConfig = config.policy ?? {
    allowed_repos: ["*"],
    allowed_workflows: ["*"],
    allowed_slack_channels: ["*"],
  };

  if (!matches(policy.allowed_repos, o.repoId)) {
    throw new PolicyError(`Repo "${o.repoId}" is not in the allowed repos list`);
  }
  if (!matches(policy.allowed_workflows, o.workflow)) {
    throw new PolicyError(`Workflow "${o.workflow}" is not in the allowed workflows list`);
  }
  if (o.channel && !matches(policy.allowed_slack_channels, o.channel)) {
    throw new PolicyError(`Slack channel "${o.channel}" is not in the allowed channels list`);
  }
}

export function appendAuditLog(entry: {
  ts: string;
  slackUser?: string;
  channel?: string;
  repoId: string;
  workflow: string;
  runId: string;
  surface?: string;
}): void {
  const config = loadConfig();
  const stateDir = resolveHubPath(config.paths.state_dir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  const logPath = path.join(stateDir, "audit.log");
  const line = JSON.stringify(entry);
  fs.appendFileSync(logPath, line + "\n");
}
