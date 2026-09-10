/** Explicit in-process fixture. Does not test webhook behavior or open sockets. */
export class OfflineWebhookFixture {
  readonly ready = Promise.resolve();
  pauseAdmission() { return () => {}; }
  close() {}
}
