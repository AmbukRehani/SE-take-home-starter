import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { listTrials, getTrialById } from "../services/trial-service.js";
import {
  streamAnalysis,
  getTrialSummary,
} from "../services/analysis-service.js";
import type { TrialListResponse, ErrorResponse } from "../types.js";

const router = Router();

const listQuerySchema = z.object({
  phase: z.enum(["I", "II", "III"]).optional(),
  status: z.enum(["recruiting", "completed", "terminated"]).optional(),
  minEnrollment: z.coerce.number().int().nonnegative().optional(),
  sponsor: z.string().trim().min(1).max(200).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(["startDate", "enrollment", "adverseEventRate"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

router.get(
  "/",
  (req: Request, res: Response<TrialListResponse | ErrorResponse>) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
      return;
    }
    const q = parsed.data;

    const result = listTrials({
      ...(q.phase !== undefined && { phase: q.phase }),
      ...(q.status !== undefined && { status: q.status }),
      ...(q.minEnrollment !== undefined && { minEnrollment: q.minEnrollment }),
      ...(q.sponsor !== undefined && { sponsor: q.sponsor }),
      ...(q.search !== undefined && { search: q.search }),
      ...(q.sort !== undefined && { sort: q.sort }),
      ...(q.order !== undefined && { order: q.order }),
    });

    res.json(result);
  }
);

router.get("/:id", (req: Request, res: Response) => {
  const trial = getTrialById(req.params.id!);
  if (!trial) {
    res.status(404).json({ error: "Trial not found" });
    return;
  }
  res.json(trial);
});

router.get("/:id/summary", (req: Request, res: Response) => {
  const trial = getTrialById(req.params.id!);
  if (!trial) {
    res.status(404).json({ error: "Trial not found" });
    return;
  }

  const summary = getTrialSummary(trial);
  res.json(summary);
});

const analyzeBodySchema = z.object({
  focus: z.enum(["safety", "efficacy", "competitive"]),
});

router.post(
  "/:id/analyze",
  async (
    req: Request<{ id: string }, unknown, unknown>,
    res: Response<ErrorResponse>
  ) => {
    const trial = getTrialById(req.params.id);
    if (!trial) {
      res.status(404).json({ error: "Trial not found" });
      return;
    }

    const parsed = analyzeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
      return;
    }

    try {
      await streamAnalysis(trial, parsed.data.focus, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : "Analysis failed",
        });
      }
    }
  }
);

export { router as trialsRouter };
