# async-cancellation

Export async solve(jobs,signal). Jobs {id,delayMs} run sequentially, finishing after each delay. Abort must stop pending/later jobs promptly; return {status:cancelled,completed:IDs}. Otherwise status completed. Already-aborted signals do no work. Reject negative/nonfinite delays before work. Grader supplies AbortSignal.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
