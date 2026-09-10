# money-allocation

Input {total,weights}. Allocate nonnegative safe-integer cents proportionally with largest remainders; ties favor earlier index. Reject empty/negative/nonfinite weights, zero sum and invalid total. Return integer array.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
