import { Router, Request, Response } from "express";
import { loadConfig, PolicyConfig } from "../config";

export const policyRoutes = Router();

policyRoutes.get("/policy", (_req: Request, res: Response) => {
  const config = loadConfig();
  const policy: PolicyConfig = config.policy ?? {
    allowed_repos: ["*"],
    allowed_workflows: ["*"],
    allowed_slack_channels: ["*"],
  };
  res.json(policy);
});
