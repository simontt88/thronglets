import { describe, it, expect, beforeEach } from "vitest";
import { NotificationThrottle } from "../src/notifications.js";

describe("NotificationThrottle", () => {
  let throttle: NotificationThrottle;

  beforeEach(() => {
    throttle = new NotificationThrottle(60_000);
  });

  describe("level filtering", () => {
    it("always blocks debug messages", () => {
      expect(throttle.shouldSend("test", "debug", "msg")).toBe(false);
    });

    it("always allows critical messages", () => {
      expect(throttle.shouldSend("test", "critical", "msg1")).toBe(true);
      expect(throttle.shouldSend("test", "critical", "msg2")).toBe(true);
      expect(throttle.shouldSend("test", "critical", "msg3")).toBe(true);
    });

    it("allows first info message", () => {
      expect(throttle.shouldSend("test", "info", "msg")).toBe(true);
    });

    it("blocks repeated info within cooldown", () => {
      throttle.shouldSend("test", "info", "msg1");
      expect(throttle.shouldSend("test", "info", "msg2")).toBe(false);
    });
  });

  describe("cooldown behavior", () => {
    it("different categories are independent", () => {
      expect(throttle.shouldSend("cat-a", "info", "msg")).toBe(true);
      expect(throttle.shouldSend("cat-b", "info", "msg")).toBe(true);
      expect(throttle.shouldSend("cat-a", "info", "msg")).toBe(false);
      expect(throttle.shouldSend("cat-b", "info", "msg")).toBe(false);
    });

    it("critical resets category state", () => {
      throttle.shouldSend("test", "info", "msg1");
      throttle.shouldSend("test", "critical", "urgent");
      expect(throttle.shouldSend("test", "info", "msg2")).toBe(true);
    });
  });

  describe("batch summary", () => {
    it("returns null when no suppressed messages", () => {
      expect(throttle.getBatchSummary("test")).toBeNull();
    });

    it("returns null for single message", () => {
      throttle.shouldSend("test", "info", "msg");
      expect(throttle.getBatchSummary("test")).toBeNull();
    });

    it("returns summary for suppressed messages", () => {
      throttle.shouldSend("test", "info", "msg1");
      throttle.shouldSend("test", "info", "msg2");
      throttle.shouldSend("test", "info", "msg3");
      const summary = throttle.getBatchSummary("test");
      expect(summary).toContain("test");
      expect(summary).toContain("3x");
    });
  });

  describe("getCount", () => {
    it("returns 0 for unknown category", () => {
      expect(throttle.getCount("unknown")).toBe(0);
    });

    it("tracks message count", () => {
      throttle.shouldSend("test", "info", "msg1");
      expect(throttle.getCount("test")).toBe(1);
      throttle.shouldSend("test", "info", "msg2");
      expect(throttle.getCount("test")).toBe(2);
    });
  });

  describe("reset", () => {
    it("clears single category", () => {
      throttle.shouldSend("cat-a", "info", "msg");
      throttle.shouldSend("cat-b", "info", "msg");
      throttle.reset("cat-a");
      expect(throttle.shouldSend("cat-a", "info", "msg")).toBe(true);
      expect(throttle.shouldSend("cat-b", "info", "msg")).toBe(false);
    });

    it("resetAll clears everything", () => {
      throttle.shouldSend("cat-a", "info", "msg");
      throttle.shouldSend("cat-b", "info", "msg");
      throttle.resetAll();
      expect(throttle.shouldSend("cat-a", "info", "msg")).toBe(true);
      expect(throttle.shouldSend("cat-b", "info", "msg")).toBe(true);
    });
  });
});
