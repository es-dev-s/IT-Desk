-- Members can be added by hand (admin / team lead "Add member"): the work
-- email becomes optional and an optional employee ID is recorded.
ALTER TABLE members ALTER COLUMN email DROP NOT NULL;
ALTER TABLE members ADD COLUMN employee_id text
    CHECK (employee_id IS NULL OR employee_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$');
CREATE UNIQUE INDEX members_employee_id_uq ON members (lower(employee_id)) WHERE employee_id IS NOT NULL;
