// Synthetic responses shaped like the real Flexischools API (fake names and ids; nothing from a real account).

export const K = {
  stuA: "stu-aaaa",
  stuB: "stu-bbbb",
  school: "school-1",
  site: "site-1",
  supplier: "sup-1",
  lunch: "svc-lunch",
  recess: "svc-recess",
  lunchB: "svc-lunch-b",
  region: "region-1",
  dist: "dist-1",
};

export const studentsResponse = [
  {
    studentKey: K.stuA,
    studentFirstName: "Alice",
    studentLastName: "Example",
    schoolKey: K.school,
    schoolSiteKey: K.site,
    schoolName: "Example Girls School",
    services: [
      { supplierServiceKey: K.recess, supplierServiceName: "Junior Recess", supplierKey: K.supplier, supplierSiteKey: "ss-1", supplierSiteTimeRegionKey: K.region },
      { supplierServiceKey: K.lunch, supplierServiceName: "Junior Lunch ", supplierKey: K.supplier, supplierSiteKey: "ss-1", supplierSiteTimeRegionKey: K.region },
    ],
  },
  {
    studentKey: K.stuB,
    studentFirstName: "Bob",
    studentLastName: "Example",
    schoolKey: "school-2",
    schoolSiteKey: "site-2",
    schoolName: "Example Boys School",
    services: [{ supplierServiceKey: K.lunchB, supplierServiceName: "Lunch", supplierKey: "sup-2", supplierSiteKey: "ss-2", supplierSiteTimeRegionKey: K.region }],
  },
];

export const availableServicesResponse = [
  {
    supplierServiceKey: K.lunch,
    serviceName: "Junior Lunch",
    cutOffTime: "2026-11-06T09:30:00",
    cutOffTimeUtc: "2026-11-05T22:30:00",
    nextOrderFulfillmentDate: "2026-11-06T12:30:00",
    supplierKey: K.supplier,
    supplierDistributionTimeKey: K.dist,
  },
];

export const fulfillmentDatesResponse = [
  { fulfillmentDate: "2026-11-05T12:30:00", hasCutOffTimePassed: true, supplierDistributionTimeKey: { id: 1, value: "d-1105" }, closureReason: null },
  { fulfillmentDate: "2026-11-06T12:30:00", hasCutOffTimePassed: false, supplierDistributionTimeKey: { id: 2, value: K.dist }, closureReason: null },
  { fulfillmentDate: "2026-11-09T12:30:00", hasCutOffTimePassed: false, supplierDistributionTimeKey: { id: 3, value: "d-1109" }, closureReason: "Staff development day" },
];

const histOrder = (key: string, stu: string, name: string, svc: string, svcName: string, due: string, item: string, total: number, state: string) => ({
  orderKey: { id: 1, value: key },
  studentKey: { id: 2, value: stu },
  studentName: name,
  supplierServiceKey: svc,
  supplierServiceName: svcName,
  orderItems: [{ itemDisplayName: item, quantityOrdered: 1 }],
  orderTotal: total,
  dueDate: due,
  orderState: state,
  supplierKey: K.supplier,
});

export const orderHistoryResponse = {
  hasMoreOrders: false,
  orderCount: 3,
  presentOrders: [
    {
      dueDate: "2026-11-06T00:00:00",
      orders: [
        histOrder("ord-cancelled", K.stuA, "Alice", K.recess, "Junior Recess", "2026-11-06T10:30:00", "Bacon Roll", 6.19, "CancelledByUser"),
        histOrder("ord-lunch", K.stuA, "Alice", K.lunch, "Junior Lunch", "2026-11-06T12:30:00", "Cheese Sandwich (White)", 4.69, "Placed"),
      ],
    },
  ],
  pastOrders: [
    { dueDate: "2026-11-04T00:00:00", orders: [histOrder("ord-old", K.stuA, "Alice", K.lunch, "Junior Lunch", "2026-11-04T12:30:00", "Pizza", 8.24, "Closed")] },
  ],
};

export const orderDetailResponse = (state: string, canCancel: boolean) => ({
  orderKey: { id: 1, value: "ord-1" },
  studentName: "Alice Example",
  studentKey: { id: 2, value: K.stuA },
  serviceName: "Junior Recess",
  supplierServiceKey: { id: 3, value: K.recess },
  items: [{ itemDisplayName: "Bacon Roll", itemTotalPrice: 5.8 }],
  stateHistory: [{ state: "Placed", stateChangedOn: "2026-11-05T05:04:27.623Z" }],
  totalPrice: 6.19,
  totalGst: 0.57,
  orderFee: 0.39,
  fulfillmentDate: "2026-11-06T10:30:00",
  canCancelOrder: canCancel,
  orderState: state,
});

export const orderFeeResponse = { fee: 0.39, feeTax: 0.04 };

const mkItem = (key: string, name: string, price: number, inStock: boolean, extra: Record<string, unknown> = {}) => ({
  itemKey: key,
  name,
  itemPrice: price,
  inStock,
  unavailabilityMessage: "",
  labels: [],
  optionSets: [],
  questionSets: [],
  ...extra,
});

export const itemListResponse = {
  supplierServiceKey: K.lunch,
  supplierServiceName: "Junior Lunch",
  dueDate: "2026-11-06T12:30:00",
  supplierDistributionTimeKey: K.dist,
  itemCategories: [
    {
      name: "*Allergy Alert*",
      items: [
        mkItem("i-allergy", "ALLERGY ALERT", 0, true, {
          // The real API sends null min/max for optional sets.
          optionSets: [{ optionSetKey: "os-a", name: "allergy type", minQuantity: null, maxQuantity: null, options: [{ optionKey: "o-1", name: "NUT", optionPrice: null, inStock: true }] }],
        }),
      ],
    },
    {
      name: "Daily Special",
      items: [
        mkItem("i-pasta", "Country Bacon Pasta", 0, true, {
          labels: ["Available fortnightly Tuesday"],
          optionSets: [
            {
              optionSetKey: "os-size",
              name: "Size",
              minQuantity: 1,
              maxQuantity: 1,
              options: [
                { optionKey: "o-m", name: "Medium", optionPrice: 7.85, inStock: true, isDefault: false },
                { optionKey: "o-s", name: "Small", optionPrice: 6.6, inStock: true, isDefault: false },
                { optionKey: "o-x", name: "XL", optionPrice: 5.0, inStock: false },
              ],
            },
          ],
        }),
        mkItem("i-offweek", "Fish Burrito", 0, false, { labels: ["Available fortnightly Friday"] }),
      ],
    },
    {
      name: "Sandwiches",
      items: [
        mkItem("i-cheese", "Cheese Sandwich", 4.3, true, { labels: ["Vegetarian"] }),
        mkItem("i-sold", "Ham Sandwich", 5.4, false),
        mkItem("i-asks", "Custom Wrap", 6, true, { questionSets: [{ q: 1 }] }),
        mkItem("i-ham", "Ham & Cheese Sandwich", 5.4, true, {
          labels: ["Gluten Free Available"],
          optionSets: [
            {
              optionSetKey: "os-bread",
              name: "Bread Options",
              minQuantity: 1,
              maxQuantity: 1,
              options: [
                { optionKey: "o-white", name: "White", optionPrice: 0, inStock: true, isDefault: false },
                { optionKey: "o-whole", name: "Wholemeal", optionPrice: 0, inStock: true, isDefault: false },
                { optionKey: "o-gf", name: "GLUTEN FREE", optionPrice: 1, inStock: true, isDefault: false },
              ],
            },
          ],
        }),
      ],
    },
    {
      name: "Drinks",
      items: [
        mkItem("i-upgo", "Up & Go", 3.8, true, {
          optionSets: [
            {
              optionSetKey: "os-flavour",
              name: "Up and Go flavour",
              minQuantity: 1,
              maxQuantity: 1,
              options: [
                { optionKey: "o-van", name: "Vanilla", optionPrice: 0, inStock: false, isDefault: false }, // greyed out in the app
                { optionKey: "o-choc", name: "Chocolate", optionPrice: 0, inStock: true, isDefault: false },
                { optionKey: "o-straw", name: "Strawberry", optionPrice: 0, inStock: true, isDefault: false },
              ],
            },
          ],
        }),
      ],
    },
  ],
};

export const placeOrderResponse = {
  orderRequestId: "req-1",
  orderId: 123,
  orderKey: "ord-new",
  studentKey: K.stuA,
  supplierServiceKey: K.lunch,
  supplierKey: K.supplier,
  supplierName: "Example Canteen",
  orderPlaced: true,
  error: null,
};
