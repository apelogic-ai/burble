import { describe, expect, test } from "bun:test";
import {
  SCHEDULED_RUN_FAILURE_NOTIFICATION_POLICY,
  shouldNotifyScheduledRunFailure,
} from "../../src/scheduler/failure-notification-policy";

describe("scheduled run failure notification policy", () => {
  test("documents the route-only notification policy", () => {
    expect(SCHEDULED_RUN_FAILURE_NOTIFICATION_POLICY).toBe(
      "delivery_route_only",
    );
  });

  test("notifies manual and scheduled failures through the delivery route", () => {
    expect(
      shouldNotifyScheduledRunFailure({
        run: { triggerSource: "manual" },
        hasDestination: true,
      }),
    ).toBe(true);
    expect(
      shouldNotifyScheduledRunFailure({
        run: { triggerSource: "schedule" },
        hasDestination: true,
      }),
    ).toBe(true);
  });

  test("does not notify when no delivery destination is available", () => {
    expect(
      shouldNotifyScheduledRunFailure({
        run: { triggerSource: "manual" },
        hasDestination: false,
      }),
    ).toBe(false);
  });
});
