CREATE TABLE IF NOT EXISTS "unit_prices" (
    "material" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "unit_price" DECIMAL(12, 2) NOT NULL CHECK ("unit_price" >= 0),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_prices_pkey" PRIMARY KEY ("material", "color")
);

CREATE TABLE IF NOT EXISTS "invoice_sequences" (
    "month" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL CHECK ("last_number" >= 0),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("month")
);

CREATE TABLE IF NOT EXISTS "invoices" (
    "invoice_number" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bill_to" JSONB NOT NULL,
    "company_info" JSONB NOT NULL,
    "line_items" JSONB NOT NULL,
    "grand_total" TEXT NOT NULL,
    "top_safe_mm" INTEGER NOT NULL CHECK ("top_safe_mm" BETWEEN 10 AND 100),
    "bottom_safe_mm" INTEGER NOT NULL CHECK ("bottom_safe_mm" BETWEEN 10 AND 100),
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("invoice_number")
);

CREATE INDEX IF NOT EXISTS "idx_invoices_month_generated"
ON "invoices"("month", "generated_at" DESC);

DELETE FROM "material_colors"
WHERE (lower(trim("material")) = 'bed sheets' AND lower(trim("label")) IN ('blue', 'cream', 'green'))
   OR (lower(trim("material")) = 'table clothes' AND lower(trim("label")) IN ('blue', 'cream'))
   OR (lower(trim("material")) = 'towels' AND lower(trim("label")) IN ('blue', 'green', 'yellow'));

UPDATE "shift_orders"
SET "display_order" = CASE "shift"
    WHEN 'night' THEN 1
    WHEN 'morning' THEN 2
    WHEN 'evening' THEN 3
    WHEN 'afternoon' THEN 4
END
WHERE "shift" IN ('night', 'morning', 'evening', 'afternoon');
