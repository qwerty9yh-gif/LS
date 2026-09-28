CREATE TABLE IF NOT EXISTS "shift_orders" (
    "shift" "shift_type" NOT NULL,
    "display_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shift_orders_pkey" PRIMARY KEY ("shift"),
    CONSTRAINT "shift_orders_display_order_check" CHECK ("display_order" >= 1)
);

CREATE INDEX IF NOT EXISTS "idx_shift_orders_display_order"
ON "shift_orders"("display_order");

INSERT INTO "shift_orders" ("shift", "display_order") VALUES
    ('night', 1),
    ('afternoon', 2),
    ('evening', 3),
    ('morning', 4)
ON CONFLICT ("shift") DO NOTHING;