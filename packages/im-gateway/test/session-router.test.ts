import { describe, expect, it } from "vitest";
import { buildSessionKey } from "../src/session-router.js";

describe("buildSessionKey", () => {
  it("routes Telegram DMs by chat", () => {
    expect(
      buildSessionKey({
        platform: "telegram",
        chatId: "123",
        userId: "u1",
        text: "hello",
        chatType: "dm",
      }),
    ).toBe("telegram:dm:123");
  });

  it("routes Telegram topics separately", () => {
    expect(
      buildSessionKey({
        platform: "telegram",
        chatId: "-100",
        threadId: "42",
        userId: "u1",
        text: "hello",
        chatType: "group",
      }),
    ).toBe("telegram:group:-100:42");
  });

  it("can isolate group sessions by user", () => {
    expect(
      buildSessionKey(
        {
          platform: "telegram",
          chatId: "-100",
          userId: "u1",
          text: "hello",
          chatType: "group",
        },
        { groupSessionsPerUser: true },
      ),
    ).toBe("telegram:group:-100:u1");
  });

  it("can isolate thread sessions by user", () => {
    expect(
      buildSessionKey(
        {
          platform: "telegram",
          chatId: "-100",
          threadId: "42",
          userId: "u1",
          text: "hello",
          chatType: "group",
        },
        { threadSessionsPerUser: true },
      ),
    ).toBe("telegram:group:-100:42:u1");
  });

  it("escapes key parts so platform ids cannot collide", () => {
    expect(
      buildSessionKey({
        platform: "discord",
        chatId: "room:alpha",
        threadId: "thread/one",
        userId: "u:1",
        text: "hello",
        chatType: "group",
      }),
    ).toBe("discord:group:room%3Aalpha:thread%2Fone");
  });
});
