-- Phase 12s: a paper may open its sitting in a window of its own.
--
-- Asked for: "an option to open the test only in a full screen pop up
-- window instead of a regular tab".
--
-- A window with no address bar and no tab strip is one fewer thing to
-- wander into mid-exam, and on a shared lab machine it is the difference
-- between a candidate who has to think about leaving and one who can drift.
-- That is the whole of the claim. It is NOT containment:
--
--   * Esc always exits full screen and alt-tab always works -- browser
--     guarantees to the user, docs/PROCTORING.md 2;
--   * a popup can be blocked, in which case the sitting opens in the tab as
--     it always did, because a candidate locked out by their own popup
--     blocker would be a far worse failure than a tab;
--   * nothing about it prevents a second device, which 4 names as the thing
--     only a person in the room addresses.
--
-- Off by default, and a watching knob rather than a term of the result, so
-- it sits with `strictMode`, `onLimit` and `refuseOutsidePaste` outside the
-- frozen tuple `recx_refuse_published_assessment_change` protects.

ALTER TABLE "public"."Assessment"
  ADD COLUMN "sitInPopup" BOOLEAN NOT NULL DEFAULT false;
