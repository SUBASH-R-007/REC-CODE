import { Award } from "lucide-react";
import { describe, expect, it } from "vitest";
import { BADGES } from "../scripts/content/badges";
import { badgeIcon } from "@/components/profile/badge-shelf";

describe("badge catalogue icons", () => {
  it("every seeded badge icon maps to a real icon (not the Award fallback)", () => {
    for (const badge of BADGES) {
      expect(badgeIcon(badge.icon), `${badge.key} → ${badge.icon}`).not.toBe(Award);
    }
  });
});
