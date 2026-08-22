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

async function testRetriesBrokenStream() {
  // The exact message that killed run #50's thread pass. A dropped connection
  // says nothing about the request, so it must be re-sent.
  let calls = 0;
  const result = await callWithBackoff(
    async () => {
      calls++;
      if (calls === 1) {
        throw new Error(
          "LLM call failed: Stream broke at 311715ms after 0 bytes — stage=thread model=zai-org/glm-5.2:thinking: terminated",
        );
      }
      return "ok";
    },
    { retry_max_attempts: 3, retry_base_ms: 1 },
    "test",
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
}

async function testRecognizesTransportVariants() {
  for (const msg of [
    "socket hang up",
    "read ECONNRESET",
    "Premature close",
    "TypeError: fetch failed",
    "connection reset by peer",
  ]) {
    let calls = 0;
    await callWithBackoff(
      async () => {
        calls++;
        if (calls === 1) throw new Error(msg);
        return "ok";
      },
      { retry_max_attempts: 2, retry_base_ms: 1 },
      "test",
    );
    assert.equal(calls, 2, `expected retry for transport error: ${msg}`);
  }
}

async function testTimeoutIsNotRetried() {
  // Deliberate: a call that ran to its configured ceiling will probably do it
  // again, and the run #40 lesson was to bound those rather than repeat them.
  let calls = 0;
  await assert.rejects(() =>
    callWithBackoff(
      async () => {
        calls++;
        throw new Error("Request timed out.");
      },
      { retry_max_attempts: 3, retry_base_ms: 1 },
      "test",
    ),
  );
  assert.equal(calls, 1);
}

async function testRetriesBudgetExhaustion() {
  // Run #35: five calls hit exactly 8,001 output tokens with an empty body and
  // 32 pieces failed with them. One repair pass re-asked the same prompts and
  // recovered all 32 — the same input succeeded on the next attempt every time,
  // which is what makes this a spiral to re-ask rather than a ceiling to respect.
  let calls = 0;
  const result = await callWithBackoff(
    async () => {
      calls++;
      if (calls === 1) {
        throw new Error(
          "LLM call failed: LLM returned empty response after consuming its entire " +
            "8000-token budget (output_tokens=8001) — reasoning exhausted it before " +
            "any content was emitted. Raise max_tokens or lower reasoning_effort.",
        );
      }
      return "ok";
    },
    { retry_max_attempts: 3, retry_base_ms: 1 },
    "test",
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
}

async function testAPlainEmptyResponseIsNotRetried() {
  // Only budget exhaustion is a spiral. An empty response with no budget story
  // behind it says nothing about whether asking again would help.
  let calls = 0;
  await assert.rejects(() =>
    callWithBackoff(
      async () => {
        calls++;
        throw new Error("LLM call failed: LLM returned empty response");
      },
      { retry_max_attempts: 3, retry_base_ms: 1 },
      "test",
    ),
  );
  assert.equal(calls, 1);
}

async function main() {
  await testRetriesBudgetExhaustion();
  await testAPlainEmptyResponseIsNotRetried();
  await testSucceedsFirstTry();
  await testRetriesRateLimitThenSucceeds();
  await testExhaustsAttemptsThenThrows();
  await testNonRateLimitErrorIsNotRetried();
  await testRecognizesRateLimitVariants();
  await testHonorsRetryAfterHint();
  await testRetriesBrokenStream();
  await testRecognizesTransportVariants();
  await testTimeoutIsNotRetried();
  console.log("llm backoff tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
