/**
 * Mappers untuk convert antara bentuk data Supabase (snake_case)
 * dan bentuk data yang dipakai di UI (camelCase).
 */
import type { MenuItem } from "../data/menu";
import type { Order, PaymentMethod, Settings } from "./store";
import type { CartLine } from "../types";

/* ── MENU ITEM ── */

type MenuRow = {
  id: string;
  name: string;
  origin: string | null;
  description: string | null;
  price: number;
  category: string;
  image: string | null;
  tag: string | null;
  sold_out: boolean;
  options: unknown;
  addons: unknown;
};

export function menuFromRow(r: MenuRow): MenuItem {
  return {
    id: r.id,
    name: r.name,
    origin: r.origin ?? "",
    desc: r.description ?? "",
    price: r.price,
    category: r.category as MenuItem["category"],
    image: r.image ?? "",
    tag: r.tag ?? undefined,
    soldOut: !!r.sold_out,
    options: (r.options as MenuItem["options"]) ?? [],
    addons: (r.addons as MenuItem["addons"]) ?? [],
  };
}

export function menuToRow(m: MenuItem) {
  return {
    id: m.id,
    name: m.name,
    origin: m.origin ?? "",
    description: m.desc ?? "",
    price: m.price,
    category: m.category,
    image: m.image ?? "",
    tag: m.tag ?? null,
    sold_out: !!m.soldOut,
    options: m.options ?? [],
    addons: m.addons ?? [],
  };
}

/* ── ORDER ── */

type OrderRow = {
  id: string;
  code: string;
  name: string;
  table: string;
  method: string;
  lines: CartLine[];
  subtotal: number;
  service: number;
  tax: number;
  total: number;
  status: Order["status"];
  paid: boolean;
  placed_at: string;
};

export function orderFromRow(r: OrderRow): Order {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    table: r.table,
    method: r.method,
    lines: r.lines ?? [],
    subtotal: r.subtotal,
    service: r.service,
    tax: r.tax,
    total: r.total,
    status: r.status,
    paid: r.paid,
    placedAt: new Date(r.placed_at).getTime(),
  };
}

export function orderToInsert(o: Omit<Order, "id" | "placedAt"> & { placedAt?: number }) {
  return {
    code: o.code,
    name: o.name,
    table: o.table,
    method: o.method,
    lines: o.lines,
    subtotal: o.subtotal,
    service: o.service,
    tax: o.tax,
    total: o.total,
    status: o.status,
    paid: o.paid,
    placed_at: new Date(o.placedAt ?? Date.now()).toISOString(),
  };
}

/* ── SETTINGS ── */

type SettingsRow = {
  id: number;
  cafe_name: string;
  service_rate: number;
  tax_rate: number;
  tables: number;
  accepting_orders: boolean;
  prep_minutes: number;
  payments: PaymentMethod[];
  staff_password: string;
};

export function settingsFromRow(r: SettingsRow): Settings {
  return {
    cafeName: r.cafe_name,
    serviceRate: Number(r.service_rate),
    taxRate: Number(r.tax_rate),
    tables: r.tables,
    acceptingOrders: r.accepting_orders,
    prepMinutes: r.prep_minutes,
    payments: r.payments,
    staffPassword: r.staff_password,
  };
}

export function settingsToUpdate(s: Partial<Settings>) {
  const patch: Record<string, unknown> = {};
  if (s.cafeName !== undefined) patch.cafe_name = s.cafeName;
  if (s.serviceRate !== undefined) patch.service_rate = s.serviceRate;
  if (s.taxRate !== undefined) patch.tax_rate = s.taxRate;
  if (s.tables !== undefined) patch.tables = s.tables;
  if (s.acceptingOrders !== undefined) patch.accepting_orders = s.acceptingOrders;
  if (s.prepMinutes !== undefined) patch.prep_minutes = s.prepMinutes;
  if (s.payments !== undefined) patch.payments = s.payments;
  if (s.staffPassword !== undefined) patch.staff_password = s.staffPassword;
  return patch;
}
