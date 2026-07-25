import assert from "node:assert/strict";
import { callWithBackoff } from "../src/llm/backoff.js";

// callWithBackoff became load-bearing for grouping's attach and describe passes
// (2026-07-25). A rate-limited attach call returns an empty set, which reads as
// "the model declined every candidate" — so a retry that silently doesn't happen
// costs cluster quality invisibly. These tests pin the retry contract.
//
// All cases use a tiny retry_base_ms so the suite stays fast.

const FAST = { retry_max_attempts: 4, retry_base_ms: 1 };

function rateLimitError(): Error {
  return new Error("429 Too Many Requests");
}

async function testSucceedsFirstTry() {
  let calls = 0;
  const result = await callWithBackoff(
    async () => {
      calls++;
      return "ok";
    },
    FAST,
    "test",
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1, "should not retry a call that succeeded");
}

async function testRetriesRateLimitThenSucceeds() {
  let calls = 0;
  const result = await callWithBackoff(
    async () => {
      calls++;
      if (calls < 3) throw rateLimitError();
      return "recovered";
    },
    FAST,
    "test",
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3, "should retry until the call succeeds");
}

async function testExhaustsAttemptsThenThrows() {
  let calls = 0;
  await assert.rejects(
    () =>
      callWithBackoff(
        async () => {
          calls++;
          throw rateLimitError();
        },
        FAST,
        "test",
      ),
    /429/,
  );
  assert.equal(calls, 4, "should attempt exactly retry_max_attempts times");
}

async function testNonRateLimitErrorIsNotRetried() {
  let calls = 0;
  await assert.rejects(
    () =>
      callWithBackoff(
        async () => {
          calls++;
          throw new Error("400 Bad Request — malformed prompt");
        },
        FAST,
        "test",
      ),
    /400/,
  );
  assert.equal(calls, 1, "a non-rate-limit error should fail fast, not retry");
}

async function testRecognizesRateLimitVariants() {
  // The wrapper matches on message text because callLLM re-throws plain Errors.
  const variants = [
    "429 Too Many Requests",
    "503 Service Unavailable",
    "Rate limit exceeded for this model",
    "too many requests, slow down",
    "service unavailable",
  ];
  for (const msg of variants) {
    let calls = 0;
    await assert.rejects(() =>
      callWithBackoff(
        async () => {
          calls++;
          throw new Error(msg);
        },
        { retry_max_attempts: 2, retry_base_ms: 1 },
        "test",
      ),
    );
    assert.equal(calls, 2, `should have retried on: ${msg}`);
  }
}

async function testHonorsRetryAfterHint() {
  // "retry-after: 1" means 1 second; with base 1ms an honored hint is the only
  // way the elapsed time can exceed ~1s.
  let calls = 0;
  const started = Date.now();
  await assert.rejects(() =>
    callWithBackoff(
      async () => {
        calls++;
        throw new Error("429 rate limit; retry-after: 1");
      },
      { retry_max_attempts: 2, retry_base_ms: 1 },
      "test",
    ),
  );
  const elapsed = Date.now() - started;
  assert.equal(calls, 2);
  assert.ok(
    elapsed >= 1000,
    `expected to wait for the retry-after hint, waited ${elapsed}ms`,
  );
}

async function main() {
  await testSucceedsFirstTry();
  await testRetriesRateLimitThenSucceeds();
  await testExhaustsAttemptsThenThrows();
  await testNonRateLimitErrorIsNotRetried();
  await testRecognizesRateLimitVariants();
  await testHonorsRetryAfterHint();
  console.log("llm backoff tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
