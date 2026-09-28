CREATE TABLE IF NOT EXISTS "material_colors" (
    "id" SERIAL NOT NULL,
    "material" TEXT NOT NULL,
    "label" TEXT NOT NULL CHECK (length(trim("label")) BETWEEN 1 AND 50),
    "display_order" INTEGER NOT NULL CHECK ("display_order" >= 1),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "material_colors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "material_colors_material_label_key" UNIQUE ("material", "label")
);

CREATE INDEX IF NOT EXISTS "idx_material_colors_material_order"
ON "material_colors"("material", "display_order");

INSERT INTO "material_colors" ("material", "label", "display_order") VALUES
    ('Shirts', 'White', 1),
    ('Shirts', 'Blue', 2),
    ('Shirts', 'Brown', 3),
    ('Shirts', 'Grey', 4),
    ('Trousers', 'Grey', 1),
    ('Trousers', 'Blue', 2),
    ('Trousers', 'Brown', 3),
    ('Overcoats', 'White', 1),
    ('Overcoats', 'Blue Black', 2),
    ('Overcoats', 'Cereals High Hygiene', 3),
    ('Towels', 'White', 1),
    ('Towels', 'Blue', 2),
    ('Towels', 'Green', 3),
    ('Towels', 'Yellow', 4),
    ('Table Clothes', 'White', 1),
    ('Table Clothes', 'Cream', 2),
    ('Table Clothes', 'Blue', 3),
    ('Bed Sheets', 'White', 1),
    ('Bed Sheets', 'Cream', 2),
    ('Bed Sheets', 'Blue', 3),
    ('Bed Sheets', 'Green', 4)
ON CONFLICT ("material", "label") DO NOTHING;

INSERT INTO "material_colors" ("material", "label", "display_order")
SELECT DISTINCT r."material", r."color", 1000
FROM "records" AS r
WHERE r."material" IN ('Shirts', 'Trousers', 'Overcoats', 'Towels', 'Table Clothes', 'Bed Sheets')
  AND length(trim(r."color")) BETWEEN 1 AND 50
ON CONFLICT ("material", "label") DO NOTHING;