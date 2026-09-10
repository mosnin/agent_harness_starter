/**
 * A single, reusable checklist every {@link PlatformConnector} adapter must
 * pass, independent of its transport. Each platform (telegram, discord,
 * slack, whatsapp, signal, email, and any future adapter) gets its own
 * {@link ConnectorContractHarness} — real connector class, a scripted fake
 * transport, and platform-specific glue for "deliver one inbound message"
 * and "read what got sent back" — and {@link assertConnectorContract} runs
 * the exact same seven checks against all of them. One harness, N passes:
 * this is what proves every adapter behaves identically at the seam the rest
 * of the gateway (ConnectorHub, ContinuityRouter, PairingGuard,
 * BadgeStamper) actually depends on, instead of trusting each connector's
 * own bespoke test file to have covered the same ground.
 *
 * @module hades/gateway/connector-contract
 */

import type { PlatformConnector } from "./connector";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

/**
 * Everything {@link assertConnectorContract} needs to drive one connector
 * instance end-to-end without knowing anything about its transport.
 */
export interface ConnectorContractHarness {
  connector: PlatformConnector;
  /** Deliver one inbound message as if it arrived from the real platform. */
  emitInbound(user: string, text: string, channel?: string): Promise<void>;
  /** Everything sent back so far, in delivery order. */
  outbox(): { user: string; text: string }[];
}

function fail(message: string): never {
  throw new Error(`assertConnectorContract: ${message}`);
}

const OK_TEXT = "hello";
const EMPTY_TEXT_TRIGGER = "__assertConnectorContract_empty__";
const THROW_TRIGGER = "__assertConnectorContract_throw__";

/**
 * Run the locked per-adapter checklist against one connector, built fresh by
 * `make()`. Throws (a plain `Error`, so it drops straight into a vitest
 * `it()` body) with a specific, actionable message on the first violation.
 *
 * The checklist, in order:
 *
 *  1. `start()` with a recording handler; `emitInbound` routes to it exactly
 *     once, with the exact `user`/`text` delivered.
 *  2. A non-empty-text reply lands in `outbox()` addressed to the sender.
 *  3. An empty-text reply sends nothing (the handler still ran).
 *  4. After `stop()`, `emitInbound` invokes the handler zero additional
 *     times and the outbox is unchanged.
 *  5. `start()` after `stop()` resumes routing (restartability).
 *  6. `connector.platform` is a non-empty string, stable across the run.
 *  7. A handler that throws does not crash the harness — a later message
 *     still reaches the handler and is still delivered.
 */
export async function assertConnectorContract(
  make: () => Promise<ConnectorContractHarness> | ConnectorContractHarness,
): Promise<void> {
  const harness = await make();
  const { connector } = harness;

  // (6) platform: non-empty, stable.
  const platform = connector.platform;
  if (typeof platform !== "string" || platform.length === 0) {
    fail(`connector.platform must be a non-empty string, got ${JSON.stringify(platform)}`);
  }

  const calls: { user: string; text: string }[] = [];
  const handler = async (msg: InboundMessage): Promise<OutboundReply> => {
    calls.push({ user: msg.user, text: msg.text });
    if (msg.text === EMPTY_TEXT_TRIGGER) {
      return { text: "", accepted: true };
    }
    if (msg.text === THROW_TRIGGER) {
      throw new Error("assertConnectorContract: intentional handler failure (exercising checklist item 7)");
    }
    return { text: `reply:${msg.text}`, accepted: true };
  };

  await connector.start(handler);
  if (connector.platform !== platform) {
    fail("connector.platform changed after start()");
  }

  // (1) emitInbound routes to the handler exactly once, with matching user/text.
  calls.length = 0;
  await harness.emitInbound("alice", OK_TEXT);
  if (calls.length !== 1) {
    fail(`expected exactly 1 handler invocation for one emitInbound call, got ${calls.length}`);
  }
  if (calls[0].user !== "alice" || calls[0].text !== OK_TEXT) {
    fail(`handler received user=${JSON.stringify(calls[0].user)} text=${JSON.stringify(calls[0].text)}, expected user="alice" text=${JSON.stringify(OK_TEXT)}`);
  }

  // (2) a non-empty reply lands in outbox() addressed to the sender.
  const afterFirst = harness.outbox();
  const delivered = afterFirst.filter((o) => o.user === "alice" && o.text === `reply:${OK_TEXT}`);
  if (delivered.length !== 1) {
    fail(`expected exactly one outbox entry addressed to "alice" with text "reply:${OK_TEXT}", found ${delivered.length} (outbox=${JSON.stringify(afterFirst)})`);
  }

  // (3) an empty-text reply sends nothing, though the handler still ran.
  const outboxBeforeEmpty = harness.outbox().length;
  calls.length = 0;
  await harness.emitInbound("bob", EMPTY_TEXT_TRIGGER);
  if (calls.length !== 1) {
    fail(`empty-text case did not reach the handler exactly once (got ${calls.length})`);
  }
  const outboxAfterEmpty = harness.outbox().length;
  if (outboxAfterEmpty !== outboxBeforeEmpty) {
    fail(`an empty-text reply must send nothing, but the outbox grew from ${outboxBeforeEmpty} to ${outboxAfterEmpty}`);
  }

  // (7) a handler that throws must not crash the harness, and subsequent
  // messages must still flow. The connector itself is allowed to either
  // swallow the throw or let the rejection surface here — either is an
  // "error-free skip" from the harness's point of view as long as it does
  // not stop later messages from being handled.
  calls.length = 0;
  try {
    await harness.emitInbound("carol", THROW_TRIGGER);
  } catch {
    // Acceptable: the connector propagated the handler's rejection instead
    // of swallowing it. What matters is what happens next.
  }
  if (calls.length !== 1) {
    fail(`a throwing handler must still have been invoked exactly once, got ${calls.length}`);
  }
  calls.length = 0;
  await harness.emitInbound("dave", "still-flowing");
  if (calls.length !== 1) {
    fail("a message sent after a handler throw did not reach the handler — the throw crashed the connector's routing");
  }
  const afterThrow = harness.outbox().filter((o) => o.user === "dave" && o.text === "reply:still-flowing");
  if (afterThrow.length !== 1) {
    fail("the reply to the message sent after a handler throw was not delivered");
  }

  // (4) after stop(), no further handler invocations and an unchanged outbox.
  await connector.stop();
  calls.length = 0;
  const outboxBeforeStop = harness.outbox().length;
  await harness.emitInbound("erin", "post-stop");
  if (calls.length !== 0) {
    fail(`expected 0 handler invocations after stop(), got ${calls.length}`);
  }
  if (harness.outbox().length !== outboxBeforeStop) {
    fail("outbox changed after stop() despite zero handler invocations");
  }

  // (5) start -> stop -> start works (restartability).
  await connector.start(handler);
  calls.length = 0;
  await harness.emitInbound("frank", "restarted");
  if (calls.length !== 1) {
    fail("connector did not resume routing inbound messages after start -> stop -> start");
  }
  const afterRestart = harness.outbox().filter((o) => o.user === "frank" && o.text === "reply:restarted");
  if (afterRestart.length !== 1) {
    fail("reply after start -> stop -> start restart was not delivered");
  }

  // (6, again) platform stayed stable across the whole run.
  if (connector.platform !== platform) {
    fail(`connector.platform changed across the run: started as ${JSON.stringify(platform)}, now ${JSON.stringify(connector.platform)}`);
  }

  await connector.stop();
}
