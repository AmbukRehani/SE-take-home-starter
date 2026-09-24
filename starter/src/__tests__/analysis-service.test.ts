import { describe, it, expect } from "vitest";
import { getTrialSummary } from "../services/analysis-service.js";
import { getTrialById } from "../services/trial-service.js";
import type { ClinicalTrial } from "../types.js";

function makeTrial(overrides: Partial<ClinicalTrial>): ClinicalTrial {
  return {
    id: "TEST-1",
    name: "Test Trial",
    sponsor: "Test Sponsor",
    phase: "III",
    status: "completed",
    indication: "Test indication",
    primaryEndpoint: "Test endpoint",
    enrollment: 100,
    startDate: "2020-01-01",
    estimatedCompletionDate: "2021-01-01",
    adverseEventRate: 10,
    responseRate: 50,
    keyFindings: ["A finding"],
    ...overrides,
  };
}

describe("analysis-service", () => {
  describe("calculateRiskScore (via getTrialSummary)", () => {
    it("scores a low response rate as riskier than a high response rate", () => {
      const highResponse = getTrialSummary(makeTrial({ responseRate: 60 }));
      const lowResponse = getTrialSummary(makeTrial({ responseRate: 10 }));
      expect(lowResponse.riskScore).toBeGreaterThan(highResponse.riskScore);
    });

    it("scores RADIANT-4 (2% response) riskier than BEACON-3 (61.3% response)", () => {
      const beacon3 = getTrialSummary(getTrialById("NCT-002")!);
      const radiant4 = getTrialSummary(getTrialById("NCT-005")!);
      expect(beacon3.riskScore).toBeLessThan(radiant4.riskScore);
    });
  });

  describe("getTrialSummary", () => {
    it("does not throw for a trial with a null response rate", () => {
      const trial = getTrialById("NCT-003")!;
      expect(trial.responseRate).toBeNull();
      expect(() => getTrialSummary(trial)).not.toThrow();

      const summary = getTrialSummary(trial);
      expect(summary.summary).toContain("not yet available");
      expect(summary.summary).not.toContain("0.0%");
    });
  });
});
