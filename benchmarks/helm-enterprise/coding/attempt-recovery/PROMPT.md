# attempt-recovery

Input events for one task. start{id} begins only if neither running nor unknown; finish{id,result} completes current running attempt; interrupt{id} makes it unknown; reconcile{id,result} completes unknown attempt. Ignore stale/duplicate callbacks and starts while unknown. Fresh start after completed resets result. Return {status,id,result}, initially queued/null/null.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
