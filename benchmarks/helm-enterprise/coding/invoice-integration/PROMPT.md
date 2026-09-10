# invoice-integration

Input {lines:[{sku,quantity,unitCents}],discountBps,taxBps}. Integrate pricing.mjs and index.mjs. Positive integer quantities, nonnegative safe-integer cents and rates 0..10000 integers required. Return {subtotal,discount,tax,total,items:[{sku,cents}]}. Round discount half-up on subtotal, tax half-up on discounted subtotal; reject invalid inputs.

Export solve from index.mjs. Use Node built-ins only; preserve inputs. Change only the provided code files.
