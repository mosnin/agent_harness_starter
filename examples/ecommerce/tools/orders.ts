/**
 * E-commerce example — order management tools.
 *
 * Replace stubbed calls with your Shopify / WooCommerce / custom DB layer.
 */

import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const getOrderTool = registerTool({
  name: "ecom_get_order",
  description:
    "Look up an order by ID or order number. Returns status, items, shipping info, tracking, and payment details. Use when a customer asks about their order.",
  parameters: z.object({
    orderId: z.string().describe("Order ID or order number (e.g. #1234)"),
  }),
  async execute({ orderId }, ctx) {
    // Replace with: return OrderService.findById(orderId, { customerId: ctx.userId });
    return { orderId, customerId: ctx.userId };
  },
});

export const listOrdersTool = registerTool({
  name: "ecom_list_orders",
  description:
    "List recent orders for the current customer. Returns order status, items, and totals.",
  parameters: z.object({
    limit: z.number().int().min(1).max(20).default(5),
    status: z
      .enum(["all", "pending", "processing", "shipped", "delivered", "cancelled", "refunded"])
      .default("all"),
  }),
  async execute({ limit, status }, ctx) {
    // Replace with: return OrderService.listForCustomer(ctx.userId!, { limit, status });
    return { orders: [], customerId: ctx.userId, limit, status };
  },
});

export const initiateRefundTool = registerTool({
  name: "ecom_initiate_refund",
  description:
    "Initiate a refund for an order. Use ONLY when the customer explicitly requests a refund and you have confirmed the order details. Always state the refund amount before proceeding.",
  parameters: z.object({
    orderId: z.string().describe("Order ID to refund"),
    reason: z
      .enum(["defective", "not_as_described", "changed_mind", "not_received", "other"])
      .describe("Reason for refund"),
    refundType: z
      .enum(["full", "partial"])
      .default("full")
      .describe("Full or partial refund"),
    amount: z
      .number()
      .optional()
      .describe("Amount to refund in dollars (required for partial refunds)"),
    notes: z.string().optional().describe("Additional notes for the refund"),
  }),
  async execute({ orderId, reason, refundType, amount, notes }, ctx) {
    // Replace with: return RefundService.create({ orderId, reason, refundType, amount, notes, initiatedBy: ctx.userId });
    return {
      success: true,
      refundId: `REF-${Date.now()}`,
      orderId,
      message: `Refund initiated for order ${orderId}. Processing time: 3–5 business days.`,
    };
  },
});

export const trackShipmentTool = registerTool({
  name: "ecom_track_shipment",
  description: "Get real-time tracking information for a shipped order.",
  parameters: z.object({
    orderId: z.string().describe("Order ID"),
  }),
  async execute({ orderId }, ctx) {
    // Replace with: return ShippingService.track(orderId, ctx.userId!);
    return { orderId, trackingStatus: "in_transit" };
  },
});

export const updateShippingAddressTool = registerTool({
  name: "ecom_update_shipping_address",
  description:
    "Update the shipping address for an unshipped order. Confirm the new address with the customer before updating.",
  parameters: z.object({
    orderId: z.string(),
    newAddress: z.object({
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string(),
      state: z.string(),
      zip: z.string(),
      country: z.string().default("US"),
    }),
  }),
  async execute({ orderId, newAddress }, ctx) {
    // Verify order hasn't shipped yet before updating
    // Replace with: return OrderService.updateShipping(orderId, newAddress, ctx.userId!);
    return { success: true, orderId, newAddress };
  },
});
