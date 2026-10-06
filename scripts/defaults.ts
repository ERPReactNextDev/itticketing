/**
 * Canonical seed values for every configurable dropdown (§5 of the spec).
 *
 * Kept in a standalone module (not inside a Mongoose model) so both the seed
 * script and the tests can import them without opening a DB connection.
 */

export type SeedOption = {
  label: string;
  value: string;
  color?: string;
  slaHours?: number;
};

export type SeedDropdown = {
  type: string;
  options: SeedOption[];
};

export const SEED_DROPDOWNS: SeedDropdown[] = [
  {
    type: "department",
    options: [
      { label: "Admin", value: "admin" },
      { label: "Accounting", value: "accounting" },
      { label: "Business Development", value: "business-development" },
      { label: "Customer Service Representative", value: "customer-service-representative" },
      { label: "E-Commerce", value: "e-commerce" },
      { label: "Engineering", value: "engineering" },
      { label: "Human Resources", value: "human-resources" },
      { label: "Information Technology", value: "information-technology" },
      { label: "Marketing", value: "marketing" },
      { label: "Procurement", value: "procurement" },
      { label: "Product Development", value: "product-development" },
      { label: "Sales", value: "sales" },
      { label: "Warehouse Operations", value: "warehouse-operations" },
      { label: "Management", value: "management" },
    ],
  },
  {
    type: "requestType",
    options: [
      { label: "Advisory", value: "advisory" },
      { label: "Incident", value: "incident" },
      { label: "Maintenance", value: "maintenance" },
      { label: "Major Incident", value: "major-incident" },
      { label: "Request", value: "request" },
      { label: "Service Request", value: "service-request" },
    ],
  },
  {
    type: "mode",
    options: [
      { label: "Chat", value: "chat" },
      { label: "Email", value: "email" },
      { label: "Phone Call", value: "phone-call" },
      { label: "System Discovery", value: "system-discovery" },
      { label: "Walk In", value: "walk-in" },
      { label: "Web Form", value: "web-form" },
    ],
  },
  {
    type: "servicesGroup",
    options: [
      { label: "Service Desk", value: "service-desk" },
      { label: "System and Website Services", value: "system-and-website-services" },
    ],
  },
  {
    type: "site",
    options: [
      { label: "Disruptive - Primex", value: "disruptive-primex" },
      { label: "Disruptive - J&L", value: "disruptive-jl" },
      { label: "Buildkhem - Carmona", value: "buildkhem-carmona" },
      { label: "Disruptive - Pasig", value: "disruptive-pasig" },
      { label: "Disruptive - CMO", value: "disruptive-cmo" },
      { label: "Disruptive - Cebu", value: "disruptive-cebu" },
      { label: "Disruptive - Davao", value: "disruptive-davao" },
      { label: "Disruptive - Granville", value: "disruptive-granville" },
    ],
  },
  {
    type: "status",
    options: [
      { label: "Pending", value: "pending", color: "#eab308" },
      { label: "Scheduled", value: "scheduled", color: "#06b6d4" },
      { label: "Ongoing", value: "ongoing", color: "#f97316" },
      { label: "Resolved", value: "resolved", color: "#22c55e" },
    ],
  },
  {
    type: "priority",
    options: [
      { label: "P-1 - Critical", value: "p-1-critical", slaHours: 4, color: "#ef4444" },
      { label: "P-2 - High", value: "p-2-high", slaHours: 8, color: "#f97316" },
      { label: "P-3 - Medium", value: "p-3-medium", slaHours: 24, color: "#eab308" },
      { label: "P-4 - Low", value: "p-4-low", slaHours: 96, color: "#22c55e" },
    ],
  },
  {
    type: "typeOfConcern",
    // Current code only ever used these two values; both stay editable.
    options: [
      { label: "Incident", value: "incident" },
      { label: "Request", value: "request" },
    ],
  },
];

/** Default Super Admin login created by the seed. */
export const SEED_SUPER_ADMIN = {
  name: "Super Admin",
  email: process.env.SEED_ADMIN_EMAIL || "admin@it-ticketing.local",
  /**
   * Must satisfy `validatePasswordStrength` (10+ chars, a letter and a digit) -
   * otherwise the seeded account would hold a password the app itself rejects,
   * which is exactly the confusion `reset-password.ts` exists to undo.
   * Always paired with `mustChangePassword`, so this is only ever temporary.
   */
  password: process.env.SEED_ADMIN_PASSWORD || "ChangeMe1234",
  employeeId: "EMP-0001",
  department: "Information Technology",
  site: "Disruptive - Primex",
};

export const REQUESTOR_CSV_COLUMNS = [
  "employeeId",
  "firstName",
  "lastName",
  "email",
  "department",
  "site",
  "phone",
] as const;