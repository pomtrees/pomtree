import assert from "node:assert/strict";
import { test } from "node:test";
import { tailFollow } from "./tail.ts";

test("tailFollow stops after the producer promise rejects", async () => {
  let rejectEnded!: (err: Error) => void;
  const ended = new Promise<void>((_resolve, reject) => {
    rejectEnded = reject;
  });

  let reads = 0;
  const src = {
    async read() {
      reads += 1;
      return reads === 1 ? { text: "last", offset: 4 } : null;
    },
  };

  let sleeps = 0;
  let out = "";
  for await (const chunk of tailFollow(src, {
    ended,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        rejectEnded(new Error("producer failed"));
        return;
      }
      if (sleeps > 5) {
        throw new Error("tailFollow kept polling after the producer promise rejected");
      }
    },
  })) {
    out += chunk;
  }

  assert.equal(out, "last");
});
