/**
 * The token bucket, checked against the three things it has to get right: a
 * burst goes through, a flood does not, and waiting earns the right to ask
 * again. Everything else about it is a trade-off rather than a rule.
 */
import assert from "node:assert/strict";
import { callerOf, resetLimits, take } from "../src/lib/limit";

const LIMIT = { perMinute: 60, burst: 10 };

async function main() {
  resetLimits();

  // A burst is what a person looks like: several requests, no waiting.
  for (let i = 0; i < LIMIT.burst; i++) {
    assert.equal(take("a", LIMIT).ok, true, `request ${i + 1} of the burst was refused`);
  }

  // The one after it is what a script looks like.
  const refused = take("a", LIMIT);
  assert.equal(refused.ok, false, "the bucket never emptied");
  assert.ok(refused.retryAfter >= 1, "a refusal has to say when to come back");

  // One caller's flood is not another caller's problem.
  assert.equal(take("b", LIMIT).ok, true, "buckets are not kept apart by caller");

  // Waiting is the way back in, which is the whole point of refilling by
  // elapsed time rather than resetting on a clock edge.
  resetLimits();
  const slow = { perMinute: 60, burst: 2 };
  assert.equal(take("c", slow).ok, true);
  assert.equal(take("c", slow).ok, true);
  assert.equal(take("c", slow).ok, false, "a burst of 2 means the third is refused");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(take("c", slow).ok, true, "a second of waiting buys one request back");

  // Who is asking. Only the first hop is trusted — the rest of the chain is
  // the caller's to write — and a missing header shares one bucket rather
  // than skipping the limit.
  const asking = (headers: Record<string, string>) =>
    callerOf(new Request("https://example.test/", { headers }));
  assert.equal(asking({}), "unknown");
  assert.equal(asking({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }), "1.2.3.4");
  assert.equal(asking({ "x-real-ip": " 5.6.7.8 " }), "5.6.7.8");

  console.log("rate limit ok");
}

main();
