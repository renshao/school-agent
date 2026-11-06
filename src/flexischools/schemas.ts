// Zod schemas for the raw Flexischools responses we depend on. They are deliberately minimal: only fields we
// use are required, unknown fields are ignored. A parse failure means the API changed -> FlexiError("schema").
import { z } from "zod";

const keyObj = z.object({ id: z.number(), value: z.string() });

// GET /api/v2.0/service-categories/1/students
export const StudentsResponse = z.array(
  z.object({
    studentKey: z.string(),
    studentFirstName: z.string(),
    studentLastName: z.string(),
    schoolKey: z.string(),
    schoolSiteKey: z.string(),
    schoolName: z.string(),
    services: z.array(
      z.object({
        supplierServiceKey: z.string(),
        supplierServiceName: z.string(),
        supplierKey: z.string(),
        supplierSiteKey: z.string(),
        supplierSiteTimeRegionKey: z.string(),
      }),
    ),
  }),
);

// POST /api/v1.0/available-services
export const AvailableServicesResponse = z.array(
  z.object({
    supplierServiceKey: z.string(),
    serviceName: z.string(),
    cutOffTime: z.string(), // local, e.g. 2026-11-06T09:00:00
    cutOffTimeUtc: z.string(), // e.g. 2026-11-05T22:00:00 (no Z suffix)
    nextOrderFulfillmentDate: z.string(),
    supplierKey: z.string(),
    supplierDistributionTimeKey: z.string(),
  }),
);

// POST /api/v1.0/students/{student}/supplierservices/{service}/next-order-fulfillment-dates
export const FulfillmentDatesResponse = z.array(
  z.object({
    fulfillmentDate: z.string(),
    hasCutOffTimePassed: z.boolean(),
    supplierDistributionTimeKey: keyObj,
    closureReason: z.string().nullable().optional(),
  }),
);

const orderState = z.string(); // Placed | Printed | Closed | CancelledByUser | ... (open set)

// POST /api/v1.0/orders/order-history
const historyOrder = z.object({
  orderKey: keyObj,
  studentKey: keyObj,
  studentName: z.string(),
  supplierServiceKey: z.string(),
  supplierServiceName: z.string(),
  orderItems: z.array(z.object({ itemDisplayName: z.string(), quantityOrdered: z.number() })),
  orderTotal: z.number(),
  dueDate: z.string(),
  orderState,
  supplierKey: z.string(),
});
const historyDay = z.object({ dueDate: z.string(), orders: z.array(historyOrder) });
export const OrderHistoryResponse = z.object({
  hasMoreOrders: z.boolean(),
  orderCount: z.number(),
  presentOrders: z.array(historyDay).default([]),
  pastOrders: z.array(historyDay).default([]),
});

// GET /api/v1.0/orders/{orderKey}
export const OrderDetailResponse = z.object({
  orderKey: keyObj,
  studentName: z.string(),
  studentKey: keyObj,
  serviceName: z.string(),
  supplierServiceKey: keyObj,
  items: z.array(z.object({ itemDisplayName: z.string(), itemTotalPrice: z.number() })),
  stateHistory: z.array(z.object({ state: z.string(), stateChangedOn: z.string() })),
  totalPrice: z.number(),
  totalGst: z.number(),
  orderFee: z.number(),
  fulfillmentDate: z.string(),
  canCancelOrder: z.boolean(),
  orderState,
});

// GET /api/v2.0/orders/{student}/supplierservices/{service}/orderfee
export const OrderFeeResponse = z.object({ fee: z.number(), feeTax: z.number() });

// GET /api/v2.0/suppliers/{supplier}/supplierservices/{service}/itemlist
const option = z.object({
  optionKey: z.string(),
  name: z.string(),
  optionPrice: z.number().nullable().transform((v) => v ?? 0),
  inStock: z.boolean(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
const optionSet = z.object({
  optionSetKey: z.string(),
  name: z.string(),
  // The API sends null for optional/unbounded sets (e.g. the allergy-alert set).
  minQuantity: z.number().nullable().transform((v) => v ?? 0),
  maxQuantity: z.number().nullable().transform((v) => v ?? 0),
  options: z.array(option),
});
const menuItem = z.object({
  itemKey: z.string(),
  name: z.string(),
  itemPrice: z.number(),
  inStock: z.boolean(),
  unavailabilityMessage: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  optionSets: z.array(optionSet).default([]),
  questionSets: z.array(z.unknown()).default([]),
});
export const ItemListResponse = z.object({
  supplierServiceKey: z.string(),
  supplierServiceName: z.string(),
  dueDate: z.string(),
  supplierDistributionTimeKey: z.string(),
  itemCategories: z.array(z.object({ name: z.string(), items: z.array(menuItem) })),
});

// GraphQL at servicebff (POST /api/v1.0/graphql/). Errors come back as HTTP 200 with `errors`.
export const GraphqlEnvelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

// query getUserAccount($userKey: String!)
export const UserAccountData = z.object({
  getUserAccount: z.object({
    accountKey: z.string(),
    accountState: z.string(),
    availableBalance: z.number(),
    currentBalance: z.number(),
  }),
});

// query findTransactions($accountKey: ID!, $transactionDateFrom: DateTime!, $transactionDateTo: DateTime!)
export const TransactionsData = z.object({
  findTransactions: z.array(
    z.object({
      balance: z.number(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      description: z.string().nullable(),
      debitCredit: z.number(),
      orderId: z.union([z.string(), z.number()]).nullable(),
      transactionDate: z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a date"),
      userKey: z.string().nullable(),
    }),
  ),
});
