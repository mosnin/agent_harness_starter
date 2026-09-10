# dependency-batches

Input {tasks:[{id,dependsOn:[]}],limit}. Return batches of ready IDs in input order, max limit per batch. Dependencies must finish in earlier batches. Reject duplicate/missing IDs, cycles and limits outside integers 1..8.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
