SET @loan_guest_migration = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='loans' AND column_name='guest_name'),
  'SELECT 1',
  'ALTER TABLE loans MODIFY COLUMN borrower_id BIGINT UNSIGNED NULL,
    ADD COLUMN guest_name VARCHAR(160) NULL,
    ADD CONSTRAINT chk_loan_borrower_identity CHECK (
      (borrower_id IS NOT NULL AND guest_name IS NULL) OR
      (borrower_id IS NULL AND NULLIF(TRIM(guest_name), '''') IS NOT NULL)
    )'
);
PREPARE loan_guest_migration_stmt FROM @loan_guest_migration;
EXECUTE loan_guest_migration_stmt;
DEALLOCATE PREPARE loan_guest_migration_stmt;
