# cart-refactor

Input {cart:[{sku,quantity}],operations:[{sku,delta}]}. Return immutable cart: combine repeated operations; preserve SKU insertion order; remove zero final quantities; reject negative final quantities and noninteger deltas.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
