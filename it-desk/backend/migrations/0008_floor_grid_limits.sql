-- Larger floors: grids up to 200 x 200 (was 120 cols x 80 rows).
-- Keep in sync with domain.MinCols/MaxCols/MinRows/MaxRows and
-- Frontend/lib/floors.ts GRID (TestGridLimitsInSync checks all three).
ALTER TABLE floors
    DROP CONSTRAINT IF EXISTS floors_cols_check,
    DROP CONSTRAINT IF EXISTS floors_rows_check,
    ADD CONSTRAINT floors_cols_check CHECK (cols BETWEEN 2 AND 200),
    ADD CONSTRAINT floors_rows_check CHECK (rows BETWEEN 2 AND 200);

ALTER TABLE floor_cells
    DROP CONSTRAINT IF EXISTS floor_cells_w_check,
    DROP CONSTRAINT IF EXISTS floor_cells_h_check,
    ADD CONSTRAINT floor_cells_w_check CHECK (w BETWEEN 1 AND 200),
    ADD CONSTRAINT floor_cells_h_check CHECK (h BETWEEN 1 AND 200);
