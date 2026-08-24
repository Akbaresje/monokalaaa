import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { menu as seedMenu, type MenuItem } from "../data/menu";
import { isSupabaseReady, supabase, TABLES } from "../lib/supabase";
import {
  menuFromRow,
  menuToRow,
  orderFromRow,
  orderToInsert,
  settingsFromRow,
  settingsToUpdate,
} from "./mappers";
import type { CartLine } from "../types";

/* ── Types ─────────────────────────────────────────────────────────── */

export type OrderStatus = "new" | "preparing" | "ready" | "done" | "cancelled";

export type Order = {
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
  placedAt: number;
  status: OrderStatus;
  paid: boolean;
};

export type PaymentMethod = {
  id: string;
  label: string;
  note: string;
  enabled: boolean;
  prepaid: boolean;
};

export type Settings = {
  cafeName: string;
  serviceRate: number;
  taxRate: number;
  tables: number;
  acceptingOrders: boolean;
  prepMinutes: number;
  payments: PaymentMethod[];
  staffPassword: string;
};

/* ── Defaults ──────────────────────────────────────────────────────── */

const defaultSettings: Settings = {
  cafeName: "MONOKALA",
  serviceRate: 0.05,
  taxRate: 0.11,
  tables: 24,
  acceptingOrders: true,
  prepMinutes: 12,
  payments: [
    { id: "qris", label: "QRIS", note: "Semua e-wallet & bank", enabled: true, prepaid: true },
    { id: "card", label: "Kartu Debit / Kredit", note: "Visa · Mastercard", enabled: true, prepaid: true },
    { id: "cash", label: "Bayar di Kasir", note: "Tunai saat pengambilan", enabled: true, prepaid: false },
  ],
  staffPassword: "monokala2024",
};

/* ── Context shape ─────────────────────────────────────────────────── */

type StoreValue = {
  menu: MenuItem[];
  settings: Settings;
  orders: Order[];
  loading: boolean;
  online: boolean;

  // menu
  upsertItem: (item: MenuItem) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  toggleAvailability: (id: string) => Promise<void>;
  resetMenu: () => Promise<void>;

  // settings
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updatePayment: (id: string, patch: Partial<PaymentMethod>) => Promise<void>;

  // orders
  createOrder: (input: {
    name: string;
    table: string;
    method: string;
    lines: CartLine[];
  }) => Promise<Order>;
  setOrderStatus: (id: string, status: OrderStatus) => Promise<void>;
  markPaid: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;

  priceBreakdown: (subtotal: number) => { service: number; tax: number; total: number };
};

const StoreCtx = createContext<StoreValue | null>(null);

/* ── LocalStorage fallback helpers ─────────────────────────────────── */

const LS_KEY = "monokala:v1";

function lsLoad<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${LS_KEY}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSave(key: string, value: unknown) {
  try {
    localStorage.setItem(`${LS_KEY}:${key}`, JSON.stringify(value));
  } catch {
    /* storage full — ignore */
  }
}

/* ── Provider ──────────────────────────────────────────────────────── */

export function StoreProvider({ children }: { children: ReactNode }) {
  const online = isSupabaseReady();

  /* Initial state:
   *  - Online mode: kosong dulu, akan diisi dari Supabase.
   *  - Offline mode: langsung load dari localStorage. */
  const [menu, setMenu] = useState<MenuItem[]>(() =>
    online ? [] : lsLoad("menu", seedMenu),
  );
  const [settings, setSettings] = useState<Settings>(() =>
    online
      ? defaultSettings
      : { ...defaultSettings, ...lsLoad("settings", defaultSettings) },
  );
  const [orders, setOrders] = useState<Order[]>(() =>
    online ? [] : lsLoad("orders", [] as Order[]),
  );
  const [loading, setLoading] = useState<boolean>(online);

  /* Persist ke localStorage kalau offline (mode demo tetap bisa) */
  useEffect(() => {
    if (!online) lsSave("menu", menu);
  }, [menu, online]);
  useEffect(() => {
    if (!online) lsSave("settings", settings);
  }, [settings, online]);
  useEffect(() => {
    if (!online) lsSave("orders", orders);
  }, [orders, online]);

  /* ── INITIAL FETCH + REALTIME SUBSCRIPTION (online mode only) ── */
  useEffect(() => {
    if (!online || !supabase) return;
    const sb = supabase; // narrow for closures

    let cancelled = false;

    const bootstrap = async () => {
      setLoading(true);

      // 1) Load menu
      const menuRes = await sb.from(TABLES.menu).select("*");
      if (cancelled) return;

      let items: MenuItem[] = [];
      if (menuRes.data && menuRes.data.length > 0) {
        items = menuRes.data.map(menuFromRow);
      } else {
        // Supabase kosong → seed menu default sekali di awal
        const rows = seedMenu.map(menuToRow);
        const seedRes = await sb.from(TABLES.menu).upsert(rows).select("*");
        items = (seedRes.data ?? []).map(menuFromRow);
      }
      setMenu(items);

      // 2) Load settings (row id=1, sudah di-seed via SQL)
      const setRes = await sb.from(TABLES.settings).select("*").eq("id", 1).single();
      if (!cancelled && setRes.data) {
        setSettings(settingsFromRow(setRes.data));
      }

      // 3) Load orders (100 terbaru)
      const ordRes = await sb
        .from(TABLES.orders)
        .select("*")
        .order("placed_at", { ascending: false })
        .limit(100);
      if (!cancelled && ordRes.data) {
        setOrders(ordRes.data.map(orderFromRow));
      }

      setLoading(false);
    };

    bootstrap();

    // ── Realtime channels ──
    const ch = sb
      .channel("monokala-live")
      .on("postgres_changes", { event: "*", schema: "public", table: TABLES.orders }, (p) => {
        if (p.eventType === "INSERT") {
          const incoming = orderFromRow(p.new as never);
          // Guard against double insert:
          //   createOrder() already prepends the row optimistically after
          //   the API returns. The realtime channel also fires INSERT for
          //   the same row. Without this dedup, `orders` grows twice per
          //   pesanan → antrean loncat A10 → A12 → A14 dan "antrean di
          //   depan" jadi dobel.
          setOrders((prev) =>
            prev.some((o) => o.id === incoming.id) ? prev : [incoming, ...prev],
          );
        } else if (p.eventType === "UPDATE") {
          setOrders((prev) =>
            prev.map((o) => (o.id === (p.new as { id: string }).id ? orderFromRow(p.new as never) : o)),
          );
        } else if (p.eventType === "DELETE") {
          const id = (p.old as { id: string }).id;
          setOrders((prev) => prev.filter((o) => o.id !== id));
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: TABLES.menu }, (p) => {
        if (p.eventType === "INSERT" || p.eventType === "UPDATE") {
          const item = menuFromRow(p.new as never);
          setMenu((prev) => {
            const i = prev.findIndex((m) => m.id === item.id);
            if (i === -1) return [...prev, item];
            const next = [...prev];
            next[i] = item;
            return next;
          });
        } else if (p.eventType === "DELETE") {
          const id = (p.old as { id: string }).id;
          setMenu((prev) => prev.filter((m) => m.id !== id));
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: TABLES.settings }, (p) => {
        setSettings(settingsFromRow(p.new as never));
      })
      .subscribe();

    return () => {
      cancelled = true;
      sb.removeChannel(ch);
    };
  }, [online]);

  /* ── Actions ───────────────────────────────────────────────────── */

  const priceBreakdown = useCallback(
    (subtotal: number) => {
      const service = Math.round(subtotal * settings.serviceRate);
      const tax = Math.round((subtotal + service) * settings.taxRate);
      return { service, tax, total: subtotal + service + tax };
    },
    [settings.serviceRate, settings.taxRate],
  );

  /* Keep a ref so createOrder can compute code from current count without
   * making the callback depend on the whole orders array. */
  const ordersRef = useRef(orders);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const upsertItem = useCallback<StoreValue["upsertItem"]>(
    async (item) => {
      // optimistic UI
      setMenu((prev) => {
        const i = prev.findIndex((m) => m.id === item.id);
        if (i === -1) return [...prev, item];
        const next = [...prev];
        next[i] = item;
        return next;
      });
      if (online && supabase) {
        const { error } = await supabase.from(TABLES.menu).upsert(menuToRow(item));
        if (error) console.error("[supabase] upsertItem:", error);
      }
    },
    [online],
  );

  const removeItem = useCallback<StoreValue["removeItem"]>(
    async (id) => {
      setMenu((prev) => prev.filter((m) => m.id !== id));
      if (online && supabase) {
        const { error } = await supabase.from(TABLES.menu).delete().eq("id", id);
        if (error) console.error("[supabase] removeItem:", error);
      }
    },
    [online],
  );

  const toggleAvailability = useCallback<StoreValue["toggleAvailability"]>(
    async (id) => {
      let target: MenuItem | undefined;
      setMenu((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m;
          target = { ...m, soldOut: !m.soldOut };
          return target;
        }),
      );
      if (online && supabase && target) {
        const { error } = await supabase
          .from(TABLES.menu)
          .update({ sold_out: target.soldOut })
          .eq("id", id);
        if (error) console.error("[supabase] toggleAvailability:", error);
      }
    },
    [online],
  );

  const resetMenu = useCallback<StoreValue["resetMenu"]>(async () => {
    setMenu(seedMenu);
    if (online && supabase) {
      const rows = seedMenu.map(menuToRow);
      const { error } = await supabase.from(TABLES.menu).upsert(rows);
      if (error) console.error("[supabase] resetMenu:", error);
    }
  }, [online]);

  const updateSettings = useCallback<StoreValue["updateSettings"]>(
    async (patch) => {
      setSettings((s) => ({ ...s, ...patch }));
      if (online && supabase) {
        const { error } = await supabase
          .from(TABLES.settings)
          .update(settingsToUpdate(patch))
          .eq("id", 1);
        if (error) console.error("[supabase] updateSettings:", error);
      }
    },
    [online],
  );

  const updatePayment = useCallback<StoreValue["updatePayment"]>(
    async (id, patch) => {
      let nextPayments: PaymentMethod[] = [];
      setSettings((s) => {
        nextPayments = s.payments.map((p) => (p.id === id ? { ...p, ...patch } : p));
        return { ...s, payments: nextPayments };
      });
      if (online && supabase) {
        const { error } = await supabase
          .from(TABLES.settings)
          .update({ payments: nextPayments })
          .eq("id", 1);
        if (error) console.error("[supabase] updatePayment:", error);
      }
    },
    [online],
  );

  const createOrder = useCallback<StoreValue["createOrder"]>(
    async ({ name, table, method, lines }) => {
      const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
      const { service, tax, total } = priceBreakdown(subtotal);

      // Nomor antrean = urutan pesanan hari ini (00:00 lokal → sekarang).
      // Lebih relevan buat dapur & tamu dibanding total historis.
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const todaySeq =
        ordersRef.current.filter((o) => o.placedAt >= startOfDay.getTime()).length + 1;
      const code = "A" + String(todaySeq).padStart(2, "0");
      const paid = settings.payments.find((p) => p.id === method)?.prepaid ?? false;

      const placedAt = Date.now();
      const base: Omit<Order, "id"> = {
        code,
        name,
        table,
        method,
        lines,
        subtotal,
        service,
        tax,
        total,
        placedAt,
        status: "new",
        paid,
      };

      if (online && supabase) {
        const { data, error } = await supabase
          .from(TABLES.orders)
          .insert(orderToInsert(base))
          .select("*")
          .single();
        if (error || !data) {
          console.error("[supabase] createOrder:", error);
          // Fallback lokal supaya user tetap dapat receipt walau DB gagal
          const fallback: Order = { ...base, id: `local-${placedAt}` };
          setOrders((prev) => [fallback, ...prev]);
          return fallback;
        }
        const saved = orderFromRow(data);
        setOrders((prev) => (prev.some((o) => o.id === saved.id) ? prev : [saved, ...prev]));
        return saved;
      }

      // Offline mode
      const local: Order = { ...base, id: `${placedAt}` };
      setOrders((prev) => [local, ...prev]);
      return local;
    },
    [online, priceBreakdown, settings.payments],
  );

  const setOrderStatus = useCallback<StoreValue["setOrderStatus"]>(
    async (id, status) => {
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)));
      if (online && supabase) {
        const { error } = await supabase.from(TABLES.orders).update({ status }).eq("id", id);
        if (error) console.error("[supabase] setOrderStatus:", error);
      }
    },
    [online],
  );

  const markPaid = useCallback<StoreValue["markPaid"]>(
    async (id) => {
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, paid: true } : o)));
      if (online && supabase) {
        const { error } = await supabase.from(TABLES.orders).update({ paid: true }).eq("id", id);
        if (error) console.error("[supabase] markPaid:", error);
      }
    },
    [online],
  );

  const clearFinished = useCallback<StoreValue["clearFinished"]>(async () => {
    setOrders((prev) => prev.filter((o) => o.status !== "done" && o.status !== "cancelled"));
    if (online && supabase) {
      const { error } = await supabase
        .from(TABLES.orders)
        .delete()
        .in("status", ["done", "cancelled"]);
      if (error) console.error("[supabase] clearFinished:", error);
    }
  }, [online]);

  const value = useMemo<StoreValue>(
    () => ({
      menu,
      settings,
      orders,
      loading,
      online,
      priceBreakdown,
      upsertItem,
      removeItem,
      toggleAvailability,
      resetMenu,
      updateSettings,
      updatePayment,
      createOrder,
      setOrderStatus,
      markPaid,
      clearFinished,
    }),
    [
      menu,
      settings,
      orders,
      loading,
      online,
      priceBreakdown,
      upsertItem,
      removeItem,
      toggleAvailability,
      resetMenu,
      updateSettings,
      updatePayment,
      createOrder,
      setOrderStatus,
      markPaid,
      clearFinished,
    ],
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
